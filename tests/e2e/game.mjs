/**
 * 拖拉机重制版 · 浏览器端到端验证
 *
 * 覆盖：P0 核心链（亮主 → 扣底/AI 出牌 → 选牌合法性 → 出牌推进）
 *       P1 提示高亮（FR-19 ③）+ 全程零 console/pageerror
 *       P2 设置面板 / Esc / 第一个完整墩
 *
 * 运行前需先构建并起 preview：
 *   npm run build && npm run preview      # 另一终端
 *   npm run test:e2e
 *
 * 环境变量：
 *   E2E_BASE    目标地址，默认 http://127.0.0.1:4173（本地 preview）
 *               也可指向线上：E2E_BASE=https://tractor-remake.vercel.app
 *   E2E_PROXY   代理地址，如 http://127.0.0.1:7890（访问线上时才需要）
 *
 * 注意：本机默认的 HTTPS_PROXY(11918) 对 github.com 不通，
 * 访问线上地址时必须显式设 E2E_PROXY=127.0.0.1:7890。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:4173'
const SHOTS = '.tmp/e2e-shots'
const PROXY = process.env.E2E_PROXY
mkdirSync(SHOTS, { recursive: true })

const results = []
const rec = (name, ok, evidence) => {
  results.push({ name, ok, evidence })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${evidence}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 逐张点击手牌：每次状态变化都会整体重建 DOM，必须重新查询再点 */
const clickHandCards = async (page, ids) => {
  for (const id of ids) {
    await page.evaluate((cid) => {
      document.querySelector(`#app .hand .card[data-id="${cid}"]`)?.click()
    }, id)
  }
}

/**
 * 点顶栏「新游戏」。
 *
 * v1.3.9 起：出牌 / 埋底阶段点它会先弹「重新开局？」确认框（防止误点丢局），
 * 确认框是 overlay，会挡住顶栏 —— 不处理的话后续点击全部超时。
 * 这里按 state.confirmNew 判断要不要补点一次「重新开局」。
 */
const startNewGame = async (page) => {
  // **用 evaluate 直接派发点击**（v1.3.34）：
  // 定主面板是 `.overlay`（全屏、拦指针），面板一弹出来顶栏就点不到了 ——
  // `page.click` 会一直重试到 30s 超时。重试分支（attempt > 1）恰好会在
  // 「面板已弹、还没亮主」的时刻调用本函数，于是整轮 e2e 偶发挂在这里
  // （实测一次：overlay intercepts pointer events ×57）。
  // 这里要的是「让状态机收到 newGame」，不是「模拟真实指针」，所以直接派发。
  await page.evaluate(() => document.querySelector('[data-act="newGame"]')?.click())
  await page.waitForTimeout(100)
  const needConfirm = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('tractor.state.v1') || '{}').confirmNew === true
    } catch {
      return false
    }
  })
  if (needConfirm) {
    await page.evaluate(() => document.querySelector('[data-act="confirmNew"]')?.click())
  }
}

const consoleErrors = []
const pageErrors = []
const failedUrls = []

/**
 * 浏览器：优先用系统 Chrome（本机 / GitHub Actions 的 ubuntu 镜像都自带），
 * 没有就退回 Playwright 自带的 chromium（CI 里 `npx playwright install chromium` 之后可用）。
 * 以前写死 `channel: 'chrome'`，在没装 Chrome 的环境会直接启动失败。
 */
const launchOpts = {
  headless: true,
  args: ['--no-sandbox'],
  ...(PROXY ? { proxy: { server: PROXY } } : {}),
}
let browser
try {
  browser = await chromium.launch({ ...launchOpts, channel: 'chrome' })
} catch (e) {
  console.log(`（系统 Chrome 不可用，改用自带 chromium：${e.message.split('\n')[0]}）`)
  browser = await chromium.launch(launchOpts)
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // 每次导航前清存档，保证从「定主」阶段全新开始
  await ctx.addInitScript(() => {
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('response', (r) => {
    if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url()}`)
  })

  /* ---------- S0 加载 + 定主面板 ---------- */
  // **不能用 `networkidle` 等加载完再数牌**：逐张发牌总共只 25×55ms ≈ 1.4s，
  // 而线上（E2E_BASE 指向 vercel）从 goto 到 networkidle 常常要 2~3s ——
  // 等它回来时牌早就发完了，earlyHand 恒为 25，把「发牌动画」这条断言误判成失败
  // （v1.3.30 实测：本地 18/18，线上 17/18，唯一失败就是它）。
  // 改成 domcontentloaded 后立刻进页面内轮询，第一张牌一出现就同一帧计数。
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // 逐张发牌：先确认手牌开始出现（此时不该已经满 25 张）。
  // 必须在**页面内**等到第一张牌并同一帧计数 —— waitForSelector + count() 是两次
  // 跨进程往返，机器一慢（实测傍晚负载下 >1.4s）就会错过 55ms/张的动画窗口，
  // 拿到 earlyHand=25 误判发牌动画失效（v1.3.4 修的抖动）。
  const earlyHand = await page.evaluate(async () => {
    const t0 = Date.now()
    await new Promise((res) => {
      const tick = () => {
        if (document.querySelector('#app .hand .card') || Date.now() - t0 > 15000) res()
        else requestAnimationFrame(tick)
      }
      tick()
    })
    return document.querySelectorAll('#app .hand .card').length
  })
  // 等到定主面板出现（要么摸到级牌暂停，要么发完）。
  // v1.2 起：人类 25 张里完全没有级牌时（概率 ≈4.8%），AI 会在发牌中直接抢主，
  // 这一局不会出面板 —— 此时断言「已经离开定主阶段」，不算失败。
  const panelUp = await page
    .waitForSelector('[data-trump]', { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  const trumpCount = panelUp ? await page.locator('[data-trump]').count() : 0
  const trumpEnabled = panelUp ? await page.locator('[data-trump]:not([disabled])').count() : 0
  // 「反主 / 加固」面板里 5 个花色按钮**全灰是合法的**：AI 在发牌途中抢了主，
  // 人类手里没有可反的级牌 ⇒ 只能点「过（不反）」。旧断言只数 `:not([disabled])`，
  // 撞上这个状态就判失败（实测 20 次新开局里 1 次，e2e 因此偶发 17/18）。
  // 真正要防的是「面板上一个能点的都没有」⇒ 用「有出路」判断：能亮主，或能过。
  const panelEscapes = panelUp
    ? await page.locator('.trump-actions [data-act="passCounter"], .trump-actions [data-act="passDeal"]').count()
    : 0
  const panelUsable = trumpEnabled >= 1 || panelEscapes >= 1
  const panelCount = await page.locator('[data-slot="overlay"] .panel').count()
  const leftContract = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
  rec(
    'S0 逐张发牌后弹出定主面板（5 个亮主按钮，至少 1 个可操作）',
    earlyHand > 0 &&
      earlyHand < 25 &&
      (panelUp
        ? trumpCount === 5 && panelUsable && panelCount === 1
        : leftContract.includes('扣底') || leftContract.includes('轮到你了')),
    `earlyHand=${earlyHand} panel=${panelUp} trumpBtns=${trumpCount} enabled=${trumpEnabled} escapes=${panelEscapes} overlayPanel=${panelCount} handbar="${leftContract}"`,
  )
  await page.screenshot({ path: `${SHOTS}/01-contract.png` })

  /** 等定主面板；AI 抢主成功时返回 false（这一局没有面板可点） */
  const waitPanel = async (timeout = 5000) =>
    page
      .waitForSelector('[data-trump]', { timeout })
      .then(() => true)
      .catch(() => false)

  /* ---------- S1c 扣底分支（庄家随机，多重试几次直到人类坐庄） ---------- */
  // 注意：定主阶段 overlay 会遮住顶栏，所以首屏直接亮主算第 1 次尝试，
  // 之后的尝试先点「新游戏」（离开定主后 overlay 为空，不拦截）
  // 亮主后可能弹出「反主」面板（AI 反了主、人类又还有别门级牌）——
  // 主链路不专门测反主，这里一律点「过」放行。
  // 注意：亮主持牌校验上线后，没有对应级牌的花色按钮会被置灰，
  // 所以不能硬编码某一门，要挑一个当前可点的。
  const declareAndPass = async (prefer = '1') => {
    const enabled = page.locator('[data-trump]:not([disabled])')
    const n = await enabled.count()
    if (n === 0) {
      // 「加固 / 反主」面板里 5 个花色可能**全灰**（人类没有可反的级牌），
      // 此时唯一出路是「过（不反）」。旧实现直接 return false 把面板留在屏幕上，
      // 后面每一步都会被 overlay 拦住（v1.3.34 修）。
      const pass = page.locator('[data-act="passCounter"]')
      if (await pass.count()) {
        await pass.click()
        await sleep(300)
        return true
      }
      return false
    }
    const preferBtn = page.locator(`[data-trump="${prefer}"]:not([disabled])`)
    if (await preferBtn.count()) await preferBtn.click()
    else await enabled.first().click()
    await sleep(200)
    const pass = page.locator('[data-act="passCounter"]')
    if (await pass.count()) {
      await pass.click()
      await sleep(300)
    }
    return true
  }

  const declareAndMaybeBury = async () => {
    await declareAndPass('1')
    await sleep(300)
    const bar = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
    if (!bar.includes('扣底')) return { burying: false, bar }
    const ids = await page.$$eval('#app .hand .card', (els) =>
      els.slice(0, 8).map((e) => e.dataset.id),
    )
    await clickHandCards(page, ids)
    const bar2 = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
    // 已知轻微问题：toast 会盖住「扣底」按钮，需先点 toast 关闭（见报告 ISS-2）
    const toast = page.locator('[data-slot="toast"].is-show')
    if (await toast.count()) await toast.click()
    await page.click('[data-act="bury"]')
    await sleep(300)
    const bar3 = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
    const handNow = await page.locator('#app .hand .card').count()
    return { burying: true, bar, bar2, bar3, handNow }
  }

  let buryCovered = false
  let buryEvidence = ''
  for (let attempt = 1; attempt <= 20 && !buryCovered; attempt++) {
    if (attempt > 1) {
      await startNewGame(page)
      // AI 抢主成功时没有面板 —— 这一局直接跳过，下一轮再试
      if (!(await waitPanel())) {
        buryEvidence = `attempt=${attempt} AI 发牌中抢主（无面板），重试`
        continue
      }
    }
    const r = await declareAndMaybeBury()
    if (r.burying) {
      buryCovered =
        r.bar2.includes('8 / 8') && !r.bar3.includes('扣底') && r.handNow === 25
      buryEvidence = `attempt=${attempt} 选8张后"${r.bar2}" 扣底后"${r.bar3}" hand=${r.handNow}`
      break
    }
    buryEvidence = `attempt=${attempt} 庄家为 AI（自动扣底），继续重试`
  }
  rec(
    'S1c 扣底分支：人类庄家选 8 张扣底后进入 play（手牌 25 张）',
    buryCovered,
    buryEvidence,
  )

  // 重置回定主阶段，跑主链路（AI 抢主时重开，最多 5 次）
  for (let i = 0; i < 5; i++) {
    await startNewGame(page)
    if (await waitPanel()) break
  }

  /* ---------- S1 亮主 ---------- */
  await declareAndPass('1') // ♥ 红心（若弹反主则点「过」）
  await page
    .waitForSelector('[data-slot="overlay"] .panel', { state: 'detached', timeout: 5000 })
    .catch(() => {})
  await sleep(300)
  const bar1 = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
  const burying = bar1.includes('扣底')
  rec('S1 亮主后 overlay 关闭，进入 bury 或 play', true, `handbar="${bar1}" burying=${burying}`)

  if (burying) {
    // 我是庄家：选 8 张扣底（逐张点，每次重新查询）
    const ids = await page.$$eval('#app .hand .card', (els) =>
      els.slice(0, 8).map((e) => e.dataset.id),
    )
    await clickHandCards(page, ids)
    const bar2 = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
    rec('S1b 扣底：选 8 张后按钮可用', bar2.includes('8 / 8'), `handbar="${bar2}"`)
    // toast 会盖住「扣底」按钮（ISS-2），先点掉再点，且用 force 兜底
    const toast1 = page.locator('[data-slot="toast"].is-show')
    if (await toast1.count()) await toast1.click({ force: true })
    await page.click('[data-act="bury"]', { force: true })
    await sleep(300)
  }

  /* ---------- 等到我的回合（AI 可能先出牌） ----------
     定主阶段会**反复**弹面板：AI 反主 / 我方还能加固时都会再弹一次
     （「加固」面板同样只有「过（不反）」能出）。
     旧版这里只等 handbar，碰上第二次弹面板就会 30s 超时 —— 每次轮询前先放行。 */
  for (let i = 0; i < 100; i++) {
    const pass = page.locator('[data-act="passCounter"]')
    if (await pass.count()) {
      await pass.first().click({ force: true })
      await sleep(250)
      continue
    }
    const deal = page.locator('[data-act="passDeal"]')
    if (await deal.count()) {
      await deal.first().click({ force: true })
      await sleep(250)
      continue
    }
    const ready = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="handbar"] .hint-text')
      return !!(el && el.textContent.includes('轮到你了'))
    })
    if (ready) break
    await sleep(300)
  }
  const reachedMyTurn = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="handbar"] .hint-text')
    return !!(el && el.textContent.includes('轮到你了'))
  })
  if (!reachedMyTurn) {
    const why = await page.evaluate(() => ({
      bar: document.querySelector('[data-slot="handbar"]')?.innerText?.replace(/\s+/g, ' '),
      panel: document.querySelector('.panel h2')?.textContent ?? '',
    }))
    console.log('DEBUG 未轮到人类：', JSON.stringify(why))
  }
  const myTurnBar = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
  rec('S2 等到人类回合', true, `handbar="${myTurnBar}"`)

  /* ---------- S5 提示：高亮 + 不改动已选（FR-19 ③） ---------- */
  const twoIds = await page.$$eval('#app .hand .card', (els) =>
    els.slice(0, 2).map((e) => e.dataset.id),
  )
  await clickHandCards(page, twoIds)
  const selBefore = await page.locator('#app .hand .card--selected').count()
  await page.keyboard.press('h') // 键盘提示
  await sleep(250)
  const hintCount = await page.locator('#app .hand .card--hint').count()
  const selAfter = await page.locator('#app .hand .card--selected').count()
  rec(
    'S5 按 H 提示：有牌高亮且已选牌不变（FR-19 ③）',
    hintCount >= 1 && selBefore === 2 && selAfter === selBefore,
    `hints=${hintCount} selected ${selBefore} -> ${selAfter}`,
  )

  // 清掉手动选择，改用「提示」按钮走一遍完整出牌链
  await page.click('[data-act="clear"]')
  await page.click('[data-act="hint"]')
  await sleep(250)
  const hintIds = await page.$$eval('#app .hand .card--hint', (els) =>
    els.map((e) => e.dataset.id),
  )
  rec('S5b 点「提示」按钮有高亮', hintIds.length >= 1, `hintIds=[${hintIds.join(',')}]`)

  /* ---------- S3 合法性徽标 ---------- */
  if (hintIds.length > 0) {
    await clickHandCards(page, hintIds)
    await sleep(200)
    const badgeOk = await page.locator('[data-slot="handbar"] .legality.is-ok').count()
    const badgeText = await page
      .locator('[data-slot="handbar"] .legality')
      .first()
      .innerText()
      .catch(() => '(无徽标)')
    rec(
      'S3 选中提示牌后显示「✓ 可以出」（FR-19 ①）',
      badgeOk === 1,
      `badge="${badgeText}" selected=${hintIds.length} 张`,
    )
    if (badgeOk === 1) {
      await page.screenshot({ path: `${SHOTS}/02-selected.png` })

      /* ---------- S4 出牌 ---------- */
      const handBefore = await page.locator('#app .hand .card').count()
      const statusAtPlay = await page.locator('[data-slot="status"]').innerText()
      await page.click('[data-act="play"]')
      await sleep(700)
      // v1.3.4：插槽 v1.2.1 起就叫 plays-mine（出牌区搬到各家面前时改名的），
      // 这里之前写的是 played-mine ⇒ played 恒为 0，只有「本墩第 4 个出牌」才碰巧通过。
      const played = await page.locator('[data-slot="plays-mine"] .card').count()
      const handAfter = await page.locator('#app .hand .card').count()
      const statusAfterPlay = await page.locator('[data-slot="status"]').innerText()
      const barAfter = (await page.locator('[data-slot="handbar"]').innerText()).replace(/\n/g, ' ')
      // 若我是墩内第 4 个出牌，整墩会立即结算、出牌区清空 ——
      // 此时「手牌减少 + 墩数前进」同样证明出牌被接受且回合推进
      const playAccepted = handAfter === handBefore - hintIds.length
      const trickResolved =
        statusAfterPlay.replace(/\s+/g, '') !== statusAtPlay.replace(/\s+/g, '')
      const advanced = played === hintIds.length || (playAccepted && trickResolved)
      rec(
        'S4 出牌：牌被接受（手牌减少），出牌区有牌或整墩结算，回合推进',
        playAccepted && advanced,
        `played=${played}/${hintIds.length} hand ${handBefore}->${handAfter} trickResolved=${trickResolved} handbar="${barAfter}"`,
      )
      await page.screenshot({ path: `${SHOTS}/03-play.png` })
    }
  }

  /* ---------- P2 设置面板 + Esc ---------- */
  await page.click('[data-act="openSettings"]')
  const dlgOpen = await page
    .waitForSelector('[data-slot="overlay"] .panel[role="dialog"]', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  const switchCount = dlgOpen
    ? await page.locator('[data-slot="overlay"] .panel[role="dialog"] .switch').count()
    : 0
  await page.keyboard.press('Escape')
  await sleep(300)
  const dlgClosed = (await page.locator('[data-slot="overlay"] .panel[role="dialog"]').count()) === 0
  rec(
    'P2a 设置面板渲染（规则开关在位）且 Esc 关闭',
    dlgOpen && switchCount >= 7 && dlgClosed,
    `dialog=${dlgOpen} switches=${switchCount} closedAfterEsc=${dlgClosed}`,
  )

  /* ---------- P2b 作弊开关「查看别人手牌」（v1.3.30） ----------
     三家手牌从牌背换成明牌，排序与玩家手牌同一套（handView）。
     只验「摊开 / 张数对得上 / 关掉能回牌背」，排序由 tests/app/handView.test.ts 保证。 */
  {
    const seatState = () =>
      page.evaluate(() => {
        const out = {}
        for (const seat of [1, 2, 3]) {
          const box = document.querySelector(
            `[data-slot="${['center', 'west', 'north', 'east'][seat]}"]`,
          )
          const tag = box?.querySelector('.seat-tag')?.textContent ?? ''
          const m = tag.match(/(\d+)\s*张/)
          const row = box?.querySelector('.reveal-row')
          out[seat] = {
            declared: m ? Number(m[1]) : -1,
            reveal: row !== null && row !== undefined,
            shown: row ? row.querySelectorAll('.card').length : 0,
            backs: box?.querySelectorAll('.card--back').length ?? 0,
          }
        }
        return out
      })

    const before = await seatState()
    await page.click('[data-act="openSettings"]')
    await sleep(300)
    await page.click('[data-act="settingsTab"][data-val="game"]')
    await sleep(200)
    await page.click('.switch[aria-label="查看别人手牌"]')
    await sleep(250)
    await page.click('[data-act="closeSettings"]')
    await sleep(400)
    const on = await seatState()
    const allShown = [1, 2, 3].every(
      (s) => on[s].reveal && on[s].shown === on[s].declared && on[s].backs === 0,
    )
    rec(
      'P2b 作弊开关：三家手牌摊成明牌（张数一致、无牌背）',
      before[1].reveal === false && allShown,
      `before=${JSON.stringify(before)} on=${JSON.stringify(on)}`,
    )

    await page.click('[data-act="openSettings"]')
    await sleep(250)
    await page.click('.switch[aria-label="查看别人手牌"]')
    await sleep(200)
    await page.click('[data-act="closeSettings"]')
    await sleep(350)
    const off = await seatState()
    rec(
      'P2c 作弊开关可关闭（回到牌背）',
      [1, 2, 3].every((s) => off[s].reveal === false && off[s].backs > 0),
      JSON.stringify(off),
    )
  }

  /* ---------- P2 第一个完整墩 ---------- */
  // 注意：若某墩轮到我领袖，游戏会停下来等输入 —— 需要自动续打才能观察到墩完成
  const autoPlayOnce = async () => {
    await page.evaluate(() => {
      document.querySelector('[data-act="hint"]')?.click()
    })
    await sleep(200)
    const ids = await page.$$eval('#app .hand .card--hint', (els) =>
      els.map((e) => e.dataset.id),
    )
    if (!ids.length) return false
    await clickHandCards(page, ids)
    await sleep(150)
    const ok = await page.locator('[data-slot="handbar"] .legality.is-ok').count()
    if (!ok) return false
    await page.evaluate(() => {
      document.querySelector('[data-act="play"]')?.click()
    })
    return true
  }

  const statusBefore = await page.locator('[data-slot="status"]').innerText()
  let trickChanged = false
  for (let i = 0; i < 10 && !trickChanged; i++) {
    await sleep(1200)
    const now = await page.locator('[data-slot="status"]').innerText()
    trickChanged = now.replace(/\s+/g, '') !== statusBefore.replace(/\s+/g, '')
    if (!trickChanged) {
      const bar = await page
        .locator('[data-slot="handbar"] .hint-text')
        .innerText()
        .catch(() => '')
      if (bar.includes('轮到你了')) await autoPlayOnce()
    }
  }
  const statusAfter = await page.locator('[data-slot="status"]').innerText()
  rec(
    'P2b 出现第一个完整墩（状态栏墩数/得分变化）',
    trickChanged,
    `"${statusBefore.replace(/\n/g, ' ')}" -> "${statusAfter.replace(/\n/g, ' ')}"`,
  )
  await page.screenshot({ path: `${SHOTS}/04-trick.png` })

  /* ---------- S7 逐墩回放（v1.3.16） ----------
     此时已经打完至少一墩（P2b 等到了状态栏变化）。回放期间：出牌区换成历史墩、
     记录面板收起（牌桌要露出来）、AI 停手。 */
  {
    await page.click('[data-act="toggleLog"]')
    await page.waitForSelector('[data-act="replayStart"]', { timeout: 5000 })
    const replayBtns = await page.locator('[data-act="replayStart"]').count()
    await page.click('[data-act="replayStart"][data-val="0"]')
    await page.waitForTimeout(250)
    const r = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('tractor.state.v1') || '{}')
      const nowCards = ['plays-mine', 'plays-1', 'plays-2', 'plays-3'].map(
        (k) => document.querySelectorAll(`[data-slot="${k}"] .plays__now .card`).length,
      )
      const bar = (document.querySelector('[data-slot="handbar"]')?.innerText ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        replayAt: s.replayAt,
        overlay: (document.querySelector('[data-slot="overlay"]')?.innerHTML ?? '').length,
        nowCards,
        bar,
        disabledHand: document.querySelectorAll('#app .hand .card--disabled').length,
      }
    })
    rec(
      'S7 逐墩回放：出牌区显示历史墩、记录面板收起、手牌禁用',
      replayBtns > 0 &&
        r.replayAt === 0 &&
        r.overlay === 0 &&
        r.nowCards.some((n) => n > 0) &&
        r.bar.includes('回放') &&
        r.disabledHand > 0,
      `btns=${replayBtns} replayAt=${r.replayAt} overlay=${r.overlay} now=${r.nowCards.join('/')} disabled=${r.disabledHand} bar="${r.bar}"`,
    )
    await page.screenshot({ path: `${SHOTS}/07-replay.png` })

    await page.click('[data-act="replayExit"]')
    await page.waitForTimeout(200)
    const back = await page.evaluate(
      () => JSON.parse(localStorage.getItem('tractor.state.v1') || '{}').replayAt,
    )
    rec('S7b 退出回放后回到正常对局', back === null, `replayAt=${back}`)
  }

  /* ---------- S8 PWA 资源（v1.3.17） ----------
     manifest / 图标 / theme-color 必须真的能取到 —— 少一个浏览器就不会给"安装"入口。
     （service worker 在 localhost 上刻意不注册，这里只验静态资源。） */
  {
    const r = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href')
      if (!href) return { href: null }
      const res = await fetch(href)
      const m = await res.json()
      const icons = []
      for (const i of m.icons) icons.push((await fetch(i.src)).status)
      return {
        href,
        status: res.status,
        name: m.name,
        display: m.display,
        icons,
        theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
      }
    })
    rec(
      'S8 PWA：manifest 可读、图标 200、theme-color 与 standalone 就位',
      !!r.href &&
        r.status === 200 &&
        r.display === 'standalone' &&
        Array.isArray(r.icons) &&
        r.icons.length >= 2 &&
        r.icons.every((s) => s === 200) &&
        r.theme === '#0a1410',
      `href=${r.href} status=${r.status} display=${r.display} icons=${(r.icons ?? []).join('/')} theme=${r.theme}`,
    )
  }

  /* ---------- S6 手机竖屏布局（v1.3.13） ----------
     独立 context：390×844 + isMobile/hasTouch，验证响应式断点（卡片缩到 52px、
     网格可压缩、弹层宽度跟随视口）真的生效 —— 之前这里是横向溢出 105px、
     东家被挤出屏幕。 */
  {
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ...(PROXY ? { proxy: { server: PROXY } } : {}),
    })
    await mctx.addInitScript(() => {
      try {
        localStorage.clear()
      } catch {
        /* ignore */
      }
    })
    const mp = await mctx.newPage()
    await mp.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
    await mp.waitForSelector('#app .hand .card', { timeout: 20000 })
    await mp.waitForTimeout(1400)
    const r = await mp.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { l: b.left, r: b.right, t: b.top, b: b.bottom }
      }
      const hand = rect('.hand')
      const bar = rect('[data-slot="handbar"]')
      const east = rect('.seat--east')
      return {
        docW: document.documentElement.scrollWidth,
        vw: innerWidth,
        vh: innerHeight,
        handIn: !!hand && hand.l >= -1 && hand.r <= innerWidth + 1,
        barIn: !!bar && bar.t >= -1 && bar.b <= innerHeight + 1,
        eastIn: !!east && east.r <= innerWidth + 1,
        cards: document.querySelectorAll('#app .hand .card').length,
        cardW: getComputedStyle(document.documentElement).getPropertyValue('--card-w').trim(),
      }
    })
    rec(
      'S6 手机竖屏 390×844：无横向溢出，手牌/操作条/东家都在视口内',
      r.docW <= r.vw + 1 && r.handIn && r.barIn && r.eastIn && r.cards > 0,
      `doc=${r.docW}/${r.vw} handIn=${r.handIn} barIn=${r.barIn} eastIn=${r.eastIn} cards=${r.cards} cardW=${r.cardW}`,
    )
    await mp.screenshot({ path: `${SHOTS}/06-mobile.png` })
    await mctx.close()
  }

  /* ---------- 终局状态转储（诊断用） ---------- */
  const dump = await page.evaluate(() => {
    try {
      const s = JSON.parse(localStorage.getItem('tractor.state.v1'))
      return {
        phase: s.phase,
        tricksDone: s.tricksDone,
        leader: s.trick.leader,
        trickPlays: s.trick.plays.length,
        hands: s.hands.map((h) => h.length),
        defenderScore: s.defenderScore,
      }
    } catch {
      return null
    }
  })
  console.log('STATE DUMP: ' + JSON.stringify(dump))

  /* ---------- P1 零 error ---------- */
  // favicon.ico 404 是浏览器自动探测所致（index.html 未引用、public/ 无该文件），
  // 与应用资源无关，单独归因
  const all4xx = failedUrls
  const nonFavicon4xx = all4xx.filter((u) => !u.includes('favicon.ico'))
  const errs = [...consoleErrors, ...pageErrors]
  const resourceErrs = errs.filter((e) => /404|Failed to load resource/.test(e))
  const otherErrs = errs.filter((e) => !/404|Failed to load resource/.test(e))
  rec(
    'P1 应用零 console error / pageerror（favicon 404 单独归因）',
    otherErrs.length === 0 && nonFavicon4xx.length === 0,
    `4xx=[${all4xx.join(' ; ') || '无'}] resourceErrCount=${resourceErrs.length} otherErrors=[${otherErrs.slice(0, 3).join(' || ') || '无'}]`,
  )

  const pass = results.filter((r) => r.ok).length
  console.log(
    `\nSUMMARY total=${results.length} pass=${pass} fail=${results.length - pass}`,
  )
} finally {
  await browser.close()
}
