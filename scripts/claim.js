#!/usr/bin/env node
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const CAPTCHA_SOLVER = path.join(__dirname, '..', 'captcha_solver.py');
const CANDIDATE_PORTS = [9222, 9223, 9224, 9225, 9226, 19222];
let CDP_PORT = null;
const PASSWORD = process.env.JQ_PASSWORD || '';
const ACCOUNTS = process.env.JQ_ACCOUNTS 
  ? process.env.JQ_ACCOUNTS.split(',')
  : [    ];
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TMP_DIR = require('os').tmpdir();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function calculateCaptchaGap(Runtime, captchaResponseText, hqBase64) {
  const payload = {
    captcha: JSON.parse(captchaResponseText.slice(captchaResponseText.indexOf('{'))),
    hqSrc: 'data:image/png;base64,' + hqBase64
  };
  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        const payload = ${JSON.stringify(payload)};
        const points = payload.captcha.data.point;
        const loadImage = src => new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('captcha image load failed'));
          image.src = src;
        });
        const [bgImage, hqImage] = await Promise.all([
          loadImage(payload.captcha.data.bgImg),
          loadImage(payload.hqSrc)
        ]);
        const makeCanvas = (width, height) => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          return canvas;
        };
        const reconstructed = makeCanvas(363, 142);
        const reconstructedContext = reconstructed.getContext('2d', { willReadFrequently: true });
        points.forEach((point, index) => {
          const column = index % 33;
          const row = Math.floor(index / 33);
          const sx = Math.abs(parseInt(point[0], 10));
          const sy = Math.abs(parseInt(point[1], 10));
          reconstructedContext.drawImage(bgImage, sx, sy, 11, 71, column * 11, row * 71, 11, 71);
        });
        const hqCanvas = makeCanvas(56, 56);
        const hqContext = hqCanvas.getContext('2d', { willReadFrequently: true });
        hqContext.drawImage(hqImage, 0, 0, 56, 56);
        const bgFull = reconstructedContext.getImageData(0, 0, 363, 142).data;
        const hqFull = hqContext.getImageData(0, 0, 56, 56).data;
        const downsize = (source, sourceWidth, sourceHeight, targetWidth, targetHeight) => {
          const canvas = makeCanvas(targetWidth, targetHeight);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
          return context.getImageData(0, 0, targetWidth, targetHeight).data;
        };
        const bgHalf = downsize(reconstructed, 363, 142, 182, 71);
        const hqHalf = downsize(hqCanvas, 56, 56, 28, 28);
        const integralSquareSum = (pixels, width, height, channel) => {
          const result = new Float64Array((width + 1) * (height + 1));
          for (let y = 1; y <= height; y++) {
            let rowSum = 0;
            for (let x = 1; x <= width; x++) {
              const offset = ((y - 1) * width + x - 1) * 4 + channel;
              rowSum += pixels[offset] * pixels[offset];
              result[y * (width + 1) + x] = result[(y - 1) * (width + 1) + x] + rowSum;
            }
          }
          return result;
        };
        const hqEnergyHalf = [0, 1, 2].reduce((total, channel) => total +
          [...hqHalf].reduce((sum, value, index) => index % 4 === channel ? sum + value * value : sum, 0), 0);
        const bgEnergiesHalf = [0, 1, 2].map(channel => integralSquareSum(bgHalf, 182, 71, channel));
        let bestScore = -Infinity;
        let bestX = 0;
        let bestY = 0;
        for (let y = 0; y <= 43; y++) {
          for (let x = 0; x <= 154; x++) {
            let numerator = 0;
            let windowEnergy = 0;
            for (let channel = 0; channel < 3; channel++) {
              const topLeft = x + y * 183;
              const right = (x + 28) + y * 183;
              const left = x + (y + 28) * 183;
              const bottom = (x + 28) + (y + 28) * 183;
              windowEnergy += bgEnergiesHalf[channel][bottom] - bgEnergiesHalf[channel][right] -
                bgEnergiesHalf[channel][left] + bgEnergiesHalf[channel][topLeft];
              for (let localY = 0; localY < 28; localY++) {
                let bgOffset = ((y + localY) * 182 + x) * 4 + channel;
                let hqOffset = localY * 28 * 4 + channel;
                for (let localX = 0; localX < 28; localX++) {
                  numerator += bgHalf[bgOffset] * hqHalf[hqOffset];
                  bgOffset += 4;
                  hqOffset += 4;
                }
              }
            }
            const score = numerator / Math.sqrt(Math.max(windowEnergy, 1) * Math.max(hqEnergyHalf, 1));
            if (score > bestScore) {
              bestScore = score;
              bestX = x;
              bestY = y;
            }
          }
        }
        let fullBestScore = -Infinity;
        let fullBestX = bestX * 2;
        let fullBestY = bestY * 2;
        const hqEnergyFull = [0, 1, 2].reduce((total, channel) => total +
          [...hqFull].reduce((sum, value, index) => index % 4 === channel ? sum + value * value : sum, 0), 0);
        const bgEnergiesFull = [0, 1, 2].map(channel => integralSquareSum(bgFull, 363, 142, channel));
        for (let y = Math.max(0, fullBestY - 4); y <= Math.min(86, fullBestY + 4); y++) {
          for (let x = Math.max(0, fullBestX - 4); x <= Math.min(307, fullBestX + 4); x++) {
            let numerator = 0;
            for (let channel = 0; channel < 3; channel++) {
              for (let localY = 0; localY < 56; localY++) {
                let bgOffset = ((y + localY) * 363 + x) * 4 + channel;
                let hqOffset = localY * 56 * 4 + channel;
                for (let localX = 0; localX < 56; localX++) {
                  numerator += bgFull[bgOffset] * hqFull[hqOffset];
                  bgOffset += 4;
                  hqOffset += 4;
                }
              }
            }
            let windowEnergy = 0;
            for (let channel = 0; channel < 3; channel++) {
              const topLeft = x + y * 364;
              const right = (x + 56) + y * 364;
              const left = x + (y + 56) * 364;
              const bottom = (x + 56) + (y + 56) * 364;
              windowEnergy += bgEnergiesFull[channel][bottom] - bgEnergiesFull[channel][right] -
                bgEnergiesFull[channel][left] + bgEnergiesFull[channel][topLeft];
            }
            const score = numerator / Math.sqrt(Math.max(windowEnergy, 1) * Math.max(hqEnergyFull, 1));
            if (score > fullBestScore) {
              fullBestScore = score;
              fullBestX = x;
              fullBestY = y;
            }
          }
        }
        return { gapX: fullBestX, score: fullBestScore };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  if (!result.result.value?.gapX) throw new Error('Browser captcha solver failed');
  return result.result.value;
}

// 探测可用的 Chrome 调试端口
async function findWorkingPort() {
  for (const port of CANDIDATE_PORTS) {
    try {
      await CDP.List({ port });
      console.log(`[Chrome] Found working debug port: ${port}`);
      return port;
    } catch (e) {
      // 端口不可用，继续探测下一个
    }
  }
  return null;
}

// 检查 Chrome 是否已启动调试端口
async function isChromeRunning(port) {
  try {
    await CDP.List({ port });
    return true;
  } catch (e) {
    return false;
  }
}

// 自动启动 Chrome
function startChrome(port) {
  console.log(`[Chrome] Starting Chrome with debug port ${port}...`);
  const userDataDir = require('os').homedir() + '/chrome_debug';
  const args = ['--user-data-dir=' + userDataDir, '--remote-debugging-port=' + port, '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-features=AutofillServerCommunication,PasswordManager,LazyLoadImages', '--disable-single-click-autofill', '--disable-autofill-keyboard-accessory-view', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--disable-infobars'];
  console.log('[Chrome] Launching with args:', args.join(' '));
  try {
    const child = require('child_process').spawn(CHROME_PATH, args, { 
      detached: true, 
      stdio: 'ignore',
      windowsHide: false
    });
    child.on('error', function(err) {
      console.log('[Chrome] spawn error:', err.code);
      // Fallback to cmd start if EACCES
      if (err.code === 'EACCES') {
        const q = String.fromCharCode(34);
        require('child_process').exec('cmd /c start "" ' + q + CHROME_PATH + q + ' ' + args.join(' '), function(e2) {
          if (e2) console.log('[Chrome] fallback error:', e2.message.substring(0, 80));
        });
      }
    });
    child.unref();
    console.log('[Chrome] Spawned directly');
  } catch(e) {
    console.log('[Chrome] Error:', e.message.substring(0, 100));
  }
}


// 等待 Chrome 调试端口就绪
async function waitForChrome(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    if (await isChromeRunning(CDP_PORT)) {
      console.log('[Chrome] Debug port ready');
      return true;
    }
    console.log(`[Chrome] Waiting for debug port... (${i + 1}/${maxRetries})`);
    await sleep(1000);
  }
  throw new Error('Chrome debug port not available after ' + maxRetries + ' seconds');
}

async function getOrCreateTab() {
  // 总是新建标签页，不关闭原有浏览器
  const tab = await CDP.New({ url: 'https://www.joinquant.com/view/user/floor?type=creditsdesc', port: CDP_PORT });
  return { wsUrl: tab.webSocketDebuggerUrl, id: tab.id };
}

async function solveCaptcha(client, retries = 5, mode = 'signin') {
  const { Runtime } = client;
  for (let attempt = 0; attempt < retries; attempt++) {
    console.log(`[Captcha] Solving (attempt ${attempt + 1}/${retries})...`);

    const captcharRes = await Runtime.evaluate({
      expression: `
        fetch('https://www.joinquant.com/common/verifyCode/captchar', {
          method: 'POST',
          headers: {'X-Requested-With': 'XMLHttpRequest'}
        }).then(r => r.text())
      `,
      awaitPromise: true,
      returnByValue: true
    });
    fs.writeFileSync(path.join(TMP_DIR, 'captcha_response.json'), captcharRes.result.value);

    const hqImgRes = await Runtime.evaluate({
      expression: `
        (async () => {
          const el = document.querySelector('#xy_img');
          if (!el) return {error: 'no xy_img'};
          const style = window.getComputedStyle(el);
          const imgUrl = style.backgroundImage.slice(4, -1).replace(/["']/g, '');
          return {base64: imgUrl.split(',')[1]};
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    if (hqImgRes.result.value?.error) {
      console.log('[Captcha] No captcha image, waiting...');
      await sleep(2000);
      continue;
    }
    fs.writeFileSync(path.join(TMP_DIR, 'hq_img.png'), Buffer.from(hqImgRes.result.value.base64, 'base64'));

    let gapSolution;
    try {
      gapSolution = await calculateCaptchaGap(Runtime, captcharRes.result.value, hqImgRes.result.value.base64);
    } catch (error) {
      console.log('[Captcha] Failed to parse GAP_X, retrying...');
      console.log('[Captcha]', error.message || error);
      await sleep(1000);
      continue;
    }
    const gapX = gapSolution.gapX;
    console.log('[Captcha] GAP_X =', gapX);

    const validateRes = await Runtime.evaluate({
      expression: `
        fetch('https://www.joinquant.com/common/verifyCode/validate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: 'axisX=${gapX}'
        }).then(r => r.json())
      `,
      awaitPromise: true,
      returnByValue: true
    });
    const validateData = validateRes.result.value;
    console.log('[Captcha] Validate:', JSON.stringify(validateData).substring(0, 150));

    if (validateData?.data?.result) {
      const token = validateData.data.token;
      console.log('[Captcha] Token obtained:', token.substring(0, 10) + '...');
      
      // Store token globally so the page can use it
      await Runtime.evaluate({
        expression: `
          window._captchaToken = '${token}';
          window._captchaSolved = true;
          // Try to set on sessionStorage too
          try { sessionStorage.setItem('captchaToken', '${token}'); } catch(e) {}
        `,
        returnByValue: true
      });
      
      if (mode === 'login') {
        // Login captcha: inject token into captcha dialog's Vue component
        const injectRes = await Runtime.evaluate({
          expression: `
            (() => {
              const token = '${token}';
              // Method 1: Find captcha dialog and its Vue component
              const dialog = document.querySelector('#yth_captchar');
              if (dialog) {
                let comp = dialog.__vue__ || dialog.__vue;
                for (let i = 0; i < 10; i++) {
                  if (!comp) break;
                  if (comp.getToken && typeof comp.getToken === 'function') {
                    comp.getToken(token);
                    return {injected: true, source: 'dialog', level: i};
                  }
                  if (!comp.$parent) break;
                  comp = comp.$parent;
                }
              }
              
              // Method 2: Search all elements for Vue component with getToken
              const allEls = document.querySelectorAll('*');
              for (const el of allEls) {
                let comp = el.__vue__ || el.__vue;
                if (comp && comp.getToken && typeof comp.getToken === 'function') {
                  comp.getToken(token);
                  return {injected: true, source: 'global', tag: el.tagName};
                }
              }
              
              // Method 3: Re-click login button (captcha already validated server-side)
              const btn = document.querySelector('button.btnPwdSubmit');
              if (btn) {
                btn.click();
                return {fallback: true, clicked: true};
              }
              
              return {error: 'no injection point found'};
            })()
          `,
          returnByValue: true
        });
        console.log('[Captcha] Login inject:', JSON.stringify(injectRes.result.value));
      } else {
        // Signin/claim mode: inject token via getToken callback (same as original skill)
        console.log('[Captcha] Injecting token via getToken...');
        
        const injectRes = await Runtime.evaluate({
          expression: `
            (() => {
              var token = '${token}';
              var results = [];
              var els = document.querySelectorAll('*');
              for (var i = 0; i < els.length; i++) {
                var el = els[i];
                var comp = el.__vue__ || el.__vue;
                if (comp && comp.getToken && typeof comp.getToken === 'function') {
                  try {
                    comp.getToken(token);
                    results.push('SUCCESS:' + el.tagName + '#' + el.id);
                    break;
                  } catch(e) {
                    results.push('ERROR:' + e.message);
                  }
                }
              }
              return results.join(',') || 'NO_GETTOKEN_FOUND';
            })()
          `,
          returnByValue: true
        });
        console.log('[Captcha] Inject:', injectRes.result.value);
      }
      
      await sleep(3000);
      return true;
    }
    
    console.log('[Captcha] Validate failed, retrying...');
    await sleep(2000 + attempt * 1000);
  }
  return false;
}

// 获取所有任务卡片信息
async function getTaskCards(Runtime) {
  const res = await Runtime.evaluate({
    expression: `
      (() => {
        const cards = [...document.querySelectorAll('.el-card')];
        const results = [];
        for (const card of cards) {
          const btns = [...card.querySelectorAll('button span')].map(s => s.textContent.trim());
          if (btns.length === 0) continue;
          const firstLine = card.textContent.trim().split('\\n')[0]?.trim() || '';
          results.push({title: firstLine.substring(0, 40), buttons: btns});
        }
        return results;
      })()
    `,
    returnByValue: true
  });
  return res.result.value || [];
}

// 在指定任务卡片内点击按钮
async function clickButtonInCard(Runtime, taskKeyword, buttonKeyword) {
  const res = await Runtime.evaluate({
    expression: `
      (() => {
        const cards = [...document.querySelectorAll('.el-card, .jq-c-task-item, [class*="card"]')];
        let targetCard = null;
        for (const card of cards) {
          if (card.textContent.includes('${taskKeyword}')) {
            targetCard = card;
            break;
          }
        }
        if (!targetCard) return {found: false, reason: 'card not found'};
        const spans = [...targetCard.querySelectorAll('button span')];
        const span = spans.find(s => s.textContent.trim().includes('${buttonKeyword}'));
        if (!span) return {found: false, reason: 'button not found', cardButtons: spans.map(s => s.textContent.trim())};
        span.parentElement.click();
        return {found: true, clicked: true, text: span.textContent.trim()};
      })()
    `,
    returnByValue: true
  });
  return res.result.value;
}

// 浏览社区文章
async function browseArticle(client, Runtime, Page) {
  console.log('[Task] Browsing community article...');

  // 获取"浏览社区文章"卡片的按钮链接
  const linkRes = await Runtime.evaluate({
    expression: `
      (() => {
        const cards = [...document.querySelectorAll('.el-card, .jq-c-task-item, [class*="card"]')];
        let targetCard = null;
        for (const card of cards) {
          if (card.textContent.includes('浏览社区文章')) {
            targetCard = card;
            break;
          }
        }
        if (!targetCard) return {found: false};
        const spans = [...targetCard.querySelectorAll('button span')];
        const span = spans.find(s => s.textContent.trim().includes('去看看'));
        if (!span) return {found: false};
        const a = span.closest('a');
        if (a && a.href) return {found: true, href: a.href};
        return {found: true, href: 'https://www.joinquant.com/view/community/list?listType=1'};
      })()
    `,
    returnByValue: true
  });

  const linkUrl = linkRes.result.value?.href || '';
  console.log('[Task] Article link:', linkUrl);

  // 如果链接直接是文章页，直接浏览
  if (linkUrl.includes('detail') || linkUrl.includes('post')) {
    await Page.navigate({ url: linkUrl });
    await sleep(5000);
  } else {
    // 导航到社区列表
    await Page.navigate({ url: linkUrl || 'https://www.joinquant.com/view/community/list?listType=1' });
    await sleep(5000);

    // 滚动加载
    await Runtime.evaluate({ expression: `window.scrollTo(0, document.body.scrollHeight);`, returnByValue: true });
    await sleep(3000);
    await Runtime.evaluate({ expression: `window.scrollTo(0, document.body.scrollHeight);`, returnByValue: true });
    await sleep(3000);

    // 从Vue组件提取postId，导航到中间文章
    const articles = await Runtime.evaluate({
      expression: `
        (() => {
          const items = [...document.querySelectorAll('.jq-c-list_community__item')];
          return items.map((item, i) => {
            let el = item;
            let postId = null;
            let title = '';
            for (let d = 0; d < 5; d++) {
              const vue = el.__vue__ || el.__vue;
              if (vue && vue.postId) {
                postId = vue.postId;
                title = vue.title || '';
                break;
              }
              el = el.parentElement;
              if (!el) break;
            }
            if (!title) {
              const textEl = item.querySelector('.jq-c-list_community__text');
              title = textEl?.textContent?.trim() || '';
            }
            return {index: i, postId, title: title.substring(0, 80)};
          }).filter(a => a.postId && a.title.length > 3);
        })()
      `,
      returnByValue: true
    });
    const articleList = articles.result.value || [];
    if (articleList.length > 0) {
      const midIndex = Math.floor(articleList.length / 2);
      const target = articleList[midIndex];
      const articleUrl = `https://www.joinquant.com/view/community/detail/${target.postId}`;
      console.log('[Task] Navigating to article:', target.title);
      await Page.navigate({ url: articleUrl });
      await sleep(5000);
    }
  }

  // 停留浏览
  console.log('[Task] Reading article for 35s...');
  await Runtime.evaluate({
    expression: `
      window.scrollTo(0, 400);
      setTimeout(() => window.scrollTo(0, 800), 10000);
      setTimeout(() => window.scrollTo(0, 1200), 20000);
      setTimeout(() => window.scrollTo(0, 1600), 30000);
    `,
    returnByValue: true
  });
  await sleep(35000);

  // 返回积分中心
  await Page.navigate({ url: 'https://www.joinquant.com/view/user/floor?type=creditsdesc' });
  await sleep(5000);
}

async function run(username) {
  // 探测可用的 Chrome 调试端口
  CDP_PORT = await findWorkingPort();

  ino=0
  while (!CDP_PORT) {
    if(ino>2){
      console.log('restarting Chrome failure, please check your Chrome installation or try to start Chrome manually with --remote-debugging-port=9222');
      break
    }
    console.log('[Chrome] No working port found, starting Chrome...');
    CDP_PORT = CANDIDATE_PORTS[0];
    startChrome(CDP_PORT);
    await waitForChrome();

    // 探测可用的 Chrome 调试端口
    CDP_PORT = await findWorkingPort();   
    ino=ino+1 
  }

  const { wsUrl: target, id: tabId } = await getOrCreateTab();
  console.log('[CDP] Connected to', target);
  let client = await CDP({ target });
  let { Runtime, Page } = client;
  await Page.enable();
  await Runtime.enable();

  // Navigate to credits page
  await Page.navigate({ url: 'https://www.joinquant.com/view/user/floor?type=creditsdesc' });
  await sleep(4000);

  // Check login state
  const pageText = await Runtime.evaluate({
    expression: `document.body.innerText`,
    returnByValue: true
  });
  const isLoggedIn = !pageText.result.value.includes('登录') && !pageText.result.value.toLowerCase().includes('login');

  if (!isLoggedIn) {
    console.log('[Login] Not logged in, performing API login...');
    
    // Navigate to login page to establish session
    await Page.navigate({ url: 'https://www.joinquant.com/user/login/index' });
    await sleep(6000);

    // API-based login: captchar -> validate -> doLoginByText with valideCode
    let loginSuccess = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      console.log(`[Login] Attempt ${attempt + 1}/5`);

      const adaptiveState = await Runtime.evaluate({
        expression: `
          (() => {
            const usernameInput = document.querySelector('input[name="username"]');
            const passwordInput = document.querySelector('input[name="pwd"]');
            if (!usernameInput || !passwordInput) return { ready: false };
            usernameInput.focus(); usernameInput.select();
            document.execCommand('insertText', false, ${JSON.stringify(username)});
            usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.focus(); passwordInput.select();
            document.execCommand('insertText', false, ${JSON.stringify(PASSWORD)});
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            const agreement = document.querySelector('#agreementBox');
            if (agreement && !agreement.checked) {
              agreement.checked = true;
              agreement.dispatchEvent(new Event('change', { bubbles: true }));
            }
            window.__jqLoginResponses = [];
            if (!window.__jqLoginCaptureInstalled) {
              const nativeFetch = window.fetch;
              window.fetch = function(...args) {
                const promise = nativeFetch.apply(this, args);
                if (String(args[0] || '').includes('/user/login/doLoginByText')) {
                  promise.then(response => response.clone().text().then(
                    text => window.__jqLoginResponses.push(text)
                  ).catch(() => {}));
                }
                return promise;
              };
              window.__jqLoginCaptureInstalled = true;
            }
            document.querySelector('.btnPwdSubmit')?.click();
            return { ready: true };
          })()
        `,
        returnByValue: true
      });

      if (!adaptiveState.result.value?.ready) {
        console.log('[Login] Login form not found');
        await sleep(2000);
        continue;
      }

      let captchaVisible = false;
      let directLoginData = null;
      for (let waited = 0; waited < 12000; waited += 500) {
        await sleep(500);
        const state = await Runtime.evaluate({
          expression: `
            (() => {
              const image = document.querySelector('#yth_captchar #xy_img');
              return {
                captchaVisible: !!(image && image.offsetWidth > 0 && image.offsetHeight > 0),
                responses: window.__jqLoginResponses || [],
                redirected: !location.pathname.includes('/user/login') && !document.querySelector('input[name="username"]')
              };
            })()
          `,
          returnByValue: true
        });
        const currentState = state.result.value || {};
        captchaVisible = currentState.captchaVisible;
        for (const responseText of currentState.responses || []) {
          try { directLoginData = JSON.parse(responseText); } catch (error) {}
        }
        if (directLoginData?.code === '00000' || directLoginData || currentState.redirected) break;
      }
      console.log(`[Login] Post-click state: captcha=${captchaVisible}, loginResponse=${!!directLoginData}`);

      if (directLoginData?.code === '00000' || (!directLoginData && !captchaVisible && adaptiveState.result.value.ready)) {
        const confirmed = await Runtime.evaluate({
          expression: "!location.pathname.includes('/user/login') && !document.querySelector('input[name=\"username\"]')",
          returnByValue: true
        });
        if (confirmed.result.value || directLoginData?.code === '00000') {
          loginSuccess = true;
          console.log('[Login] Direct login succeeded without slider captcha');
          await Page.navigate({ url: 'https://www.joinquant.com/view/user/floor?type=creditsdesc' });
          await sleep(6000);
          break;
        }
      }

      if (directLoginData && directLoginData.code !== '00000') {
        console.log(`[Login] Direct login rejected: ${directLoginData.msg || directLoginData.code}`);
        await sleep(directLoginData.code === 105 ? 5000 : 2000);
        continue;
      }

      if (captchaVisible) {
        const captcharRes = await Runtime.evaluate({
          expression: "fetch('/common/verifyCode/captchar',{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest'}}).then(r=>r.text())",
          awaitPromise: true,
          returnByValue: true
        });
        fs.writeFileSync(path.join(TMP_DIR, 'captcha_response.json'), captcharRes.result.value);

        const hqRes = await Runtime.evaluate({
          expression: "(() => { const el = document.querySelector('#xy_img'); if (!el || el.offsetWidth === 0) return null; return window.getComputedStyle(el).backgroundImage.split(',')[1].replace(/[\"')]/g, ''); })()",
          returnByValue: true
        });
        if (!hqRes.result.value) {
          console.log('[Login] Captcha appeared but image was unreadable');
          await sleep(1500);
          continue;
        }

        fs.writeFileSync(path.join(TMP_DIR, 'hq_img.png'), Buffer.from(hqRes.result.value, 'base64'));
        let gapSolution;
        console.log('[Login] Captcha dialog detected; solving in browser...');
        try {
          gapSolution = await calculateCaptchaGap(Runtime, captcharRes.result.value, hqRes.result.value);
        } catch (error) {
          console.log('[Login] Captcha solver failed:', error.message || error);
          continue;
        }

        const gapX = gapSolution.gapX;
        console.log(`[Login] Captcha detected, solved GAP_X=${gapX}`);
        const validateRes = await Runtime.evaluate({
          expression: `fetch('/common/verifyCode/validate',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:'axisX=${gapX}'}).then(r=>r.json())`,
          awaitPromise: true,
          returnByValue: true
        });
        const validateData = validateRes.result.value;
        if (!validateData?.data?.result) {
          console.log(`[Login] Captcha validation failed: ${validateData?.msg || 'unknown'}`);
          await sleep(1500);
          continue;
        }

        const captchaToken = validateData.data.token;
        const captchaLoginRes = await Runtime.evaluate({
          expression: `
            fetch('/user/login/doLoginByText', {
              method: 'POST',
              headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest'},
              body: 'username=' + encodeURIComponent(${JSON.stringify(username)}) + '&pwd=' + encodeURIComponent(${JSON.stringify(PASSWORD)}) + '&valideCode=' + encodeURIComponent('${captchaToken}')
            }).then(function(response) { return response.json(); })
          `,
          awaitPromise: true,
          returnByValue: true
        });
        const captchaLoginData = captchaLoginRes.result.value;
        if (captchaLoginData?.code === '00000') {
          loginSuccess = true;
          console.log(`[Login] Captcha login succeeded! User: ${captchaLoginData?.data?.user?.nickName || username}`);
          await Page.navigate({ url: 'https://www.joinquant.com/view/user/floor?type=creditsdesc' });
          await sleep(6000);
          break;
        }

        console.log(`[Login] Captcha login failed: ${captchaLoginData?.msg || captchaLoginData?.code}`);
        await sleep(captchaLoginData?.code === 105 ? 5000 : 2000);
        continue;
      }
      
      // Get captcha data
      const captcharRes = await Runtime.evaluate({
        expression: "fetch('/common/verifyCode/captchar',{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest'}}).then(r=>r.text())",
        awaitPromise: true, returnByValue: true
      });
      fs.writeFileSync(path.join(TMP_DIR, 'captcha_response.json'), captcharRes.result.value);

      // Get hq image - trigger dialog if not open
      let hqBase64;
      const hqRes = await Runtime.evaluate({
        expression: "(() => { const el = document.querySelector('#xy_img'); if (!el || el.offsetWidth === 0) return null; return window.getComputedStyle(el).backgroundImage.split(',')[1].replace(/[\"')]/g, ''); })()",
        returnByValue: true
      });
      
      if (!hqRes.result.value) {
        // Trigger captcha by filling form and clicking login
        await Runtime.evaluate({
          expression: `
            (() => {
              var u = document.querySelector('input[name="username"]');
              var p = document.querySelector('input[name="pwd"]');
              var cb = document.querySelector('#agreementBox');
              if (!u || !p) return;
              u.focus(); u.select(); document.execCommand('insertText', false, '${username}');
              u.dispatchEvent(new Event('input', {bubbles:true}));
              p.focus(); p.select(); document.execCommand('insertText', false, '${PASSWORD}');
              p.dispatchEvent(new Event('input', {bubbles:true}));
              if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); }
            })()
          `,
          returnByValue: true
        });
        await Runtime.evaluate({ expression: "document.querySelector('.btnPwdSubmit').click()", returnByValue: true });
        await sleep(3000);
        
        const hq2 = await Runtime.evaluate({
          expression: "(() => { const el = document.querySelector('#xy_img'); if (!el) return null; return window.getComputedStyle(el).backgroundImage.split(',')[1].replace(/[\"')]/g, ''); })()",
          returnByValue: true
        });
        if (!hq2.result.value) { continue; }
        hqBase64 = hq2.result.value;
      } else {
        hqBase64 = hqRes.result.value;
      }
      
      fs.writeFileSync(path.join(TMP_DIR, 'hq_img.png'), Buffer.from(hqBase64, 'base64'));

      // Solve captcha
      try {
        const solverOut = execSync(`python "${CAPTCHA_SOLVER}"`, { encoding: 'utf8' });
        const match = solverOut.match(/GAP_X=([0-9]+)/);
        if (!match) { continue; }
        const gapX = parseInt(match[1]);
        console.log(`[Login] GAP_X=${gapX}`);

        // Validate
        const vRes = await Runtime.evaluate({
          expression: "fetch('/common/verifyCode/validate',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:'axisX=" + gapX + "'}).then(r=>r.json())",
          awaitPromise: true, returnByValue: true
        });
        const vd = vRes.result.value;
        if (!vd?.data?.result) { await sleep(1500); continue; }

        const vToken = vd.data.token;
        console.log(`[Login] Captcha validated! Token: ${vToken.substring(0,15)}...`);

        // Login with valideCode=token
        const loginRes = await Runtime.evaluate({
          expression: `
            fetch('/user/login/doLoginByText', {
              method: 'POST',
              headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest'},
              body: 'username=${username}&pwd=${PASSWORD}&valideCode=${vToken}'
            }).then(function(r) { return r.json(); })
          `,
          awaitPromise: true, returnByValue: true
        });
        
        const loginData = loginRes.result.value;
        console.log(`[Login] Response code: ${loginData?.code}`);
        
        if (loginData?.code === '00000') {
          loginSuccess = true;
          console.log(`[Login] Success! User: ${loginData?.data?.user?.nickName || username}`);
          
          // Navigate to credits page
          await Page.navigate({ url: 'https://www.joinquant.com/view/user/floor?type=creditsdesc' });
          await sleep(6000);
          break;
        } else {
          console.log(`[Login] Failed: ${loginData?.msg}`);
          if (loginData?.code === 105) {
            console.log('[Login] Rate limited, waiting...');
            await sleep(5000);
          } else {
            await sleep(2000);
          }
        }
      } catch(err) {
        console.error('[Login Error]', err.message ? err.message.substring(0, 200) : err);
        await sleep(2000);
      }
    }
    
    if (!loginSuccess) {
      throw new Error('Login failed after 5 attempts');
    }
  }

// ==================== Phase 1: 签到 ====================
  console.log('\n[Phase 1] Sign-in...');
  const signInBtn = await Runtime.evaluate({
    expression: `
      (() => {
        const span = [...document.querySelectorAll('button span')].find(s => s.textContent.trim() === '签到');
        return {found: !!span};
      })()
    `,
    returnByValue: true
  });

  if (signInBtn.result.value?.found) {
    await Runtime.evaluate({
      expression: `
        (() => {
          const span = [...document.querySelectorAll('button span')].find(s => s.textContent.trim() === '签到');
          if (span) span.parentElement.click();
        })()
      `,
      returnByValue: true
    });
    await sleep(2000);
    const hasCaptcha = await Runtime.evaluate({
      expression: `!!document.querySelector('#yth_captchar #xy_img')`,
      returnByValue: true
    });
    if (hasCaptcha.result.value) await solveCaptcha(client);
    console.log('[Phase 1] Sign-in clicked');
  } else {
    console.log('[Phase 1] Already signed in or no sign-in button');
  }

  // Reload to get fresh state
  await Page.reload();
  await sleep(6000);

  // ==================== Phase 2: 打印当前任务状态 ====================
  console.log('\n[Phase 2] Current task status:');
  const cards = await getTaskCards(Runtime);
  if (cards.length === 0) {
    console.log('  (No task cards detected, retrying after 3s...)');
    await sleep(3000);
    const cardsRetry = await getTaskCards(Runtime);
    for (const card of cardsRetry) {
      console.log(`  - ${card.title}: [${card.buttons.join(', ')}]`);
    }
  } else {
    for (const card of cards) {
      console.log(`  - ${card.title}: [${card.buttons.join(', ')}]`);
    }
  }

  // ==================== Phase 3: 领取所有"立即领取" ====================
  console.log('\n[Phase 3] Claiming all "立即领取" points...');
  const claimTasks = [
    { keyword: '浏览社区文章', name: 'Browse Article' },
    { keyword: '策略被克隆', name: 'Strategy Cloned' },
    { keyword: '研究被克隆', name: 'Research Cloned' },
    { keyword: '文章被点赞', name: 'Article Liked' },
  ];

  for (const task of claimTasks) {
    const result = await clickButtonInCard(Runtime, task.keyword, '立即领取');
    if (result?.found) {
      console.log(`  [Claimed] ${task.name}: ${result.text}`);
      await sleep(2000);
      // 检查是否有验证码
      const hasCaptcha = await Runtime.evaluate({
        expression: `!!document.querySelector('#yth_captchar #xy_img')`,
        returnByValue: true
      });
      if (hasCaptcha.result.value) {
        await solveCaptcha(client);
        await Page.reload();
        await sleep(3000);
      }
    } else if (result?.reason === 'button not found') {
      console.log(`  [Skip] ${task.name}: no "立即领取" button`);
    } else if (result?.reason === 'card not found') {
      console.log(`  [Skip] ${task.name}: task card not found`);
    }
  }

  // ==================== Phase 4: 处理"去看看"/"再去看看"（仅浏览社区文章）====================
  console.log('\n[Phase 4] Checking "去看看" tasks...');
  const browseCard = cards.find(c => c.title.includes('浏览社区文章'));
  if (browseCard && browseCard.buttons.some(b => b.includes('去看看'))) {
    console.log('[Phase 4] Browse article task has "去看看", starting browse...');
    await browseArticle(client, Runtime, Page);

    // 浏览回来后先刷新页面确保状态最新
    console.log('[Phase 4] Reloading page after browse...');
    await Page.reload();
    await sleep(6000);

    // 浏览回来后再次尝试领取
    console.log('[Phase 4] Trying to claim after browse...');
    const claimResult = await clickButtonInCard(Runtime, '浏览社区文章', '立即领取');
    if (claimResult?.found) {
      console.log('[Phase 4] Browse points claim clicked, checking captcha...');
      await sleep(2000);
      // 检查是否触发验证码（与Phase 3保持一致）
      const hasCaptcha = await Runtime.evaluate({
        expression: `!!document.querySelector('#yth_captchar #xy_img')`,
        returnByValue: true
      });
      if (hasCaptcha.result.value) {
        console.log('[Phase 4] Captcha detected, solving...');
        await solveCaptcha(client);
        await Page.reload();
        await sleep(4000);
      }
      console.log('[Phase 4] Browse points claimed!');
    } else if (claimResult?.reason === 'button not found') {
      console.log('[Phase 4] No "立即领取" button after browse, task may need more time');
    }
  } else {
    console.log('[Phase 4] No "去看看" in browse article task');
  }

  // ==================== Phase 4.5: 再次检查"立即领取"（处理延迟）====================
  console.log('\n[Phase 4.5] Rechecking "立即领取" after browse...');
  await Page.reload();
  await sleep(6000);
  const recheckResult = await clickButtonInCard(Runtime, '浏览社区文章', '立即领取');
  if (recheckResult?.found) {
    console.log('[Phase 4.5] Found delayed claim button, clicking...');
    await sleep(2000);
    const hasCaptcha = await Runtime.evaluate({
      expression: `!!document.querySelector('#yth_captchar #xy_img')`,
      returnByValue: true
    });
    if (hasCaptcha.result.value) {
      await solveCaptcha(client);
      await Page.reload();
      await sleep(4000);
    }
  }

  // ==================== Phase 5: 最终状态 ====================
  console.log('\n[Phase 5] Final status:');
  await Page.reload();
  await sleep(6000);

  const finalCards = await getTaskCards(Runtime);
  if (finalCards.length === 0) {
    console.log('  (No task cards detected, retrying after 3s...)');
    await sleep(3000);
    const finalCardsRetry = await getTaskCards(Runtime);
    for (const card of finalCardsRetry) {
      console.log(`  - ${card.title}: [${card.buttons.join(', ')}]`);
    }
  } else {
    for (const card of finalCards) {
      console.log(`  - ${card.title}: [${card.buttons.join(', ')}]`);
    }
  }

  const available = await Runtime.evaluate({
    expression: `
      [...document.querySelectorAll('span')].find(s => s.previousSibling?.textContent?.includes('可用积分'))?.textContent?.trim() || ''
    `,
    returnByValue: true
  });
  const total = await Runtime.evaluate({
    expression: `document.querySelector('h4 + p span')?.textContent?.trim() || ''`,
    returnByValue: true
  });
  console.log(`\n  Available: ${available.result.value}`);
  console.log(`  Total: ${total.result.value}`);

  // 保留标签页，不关闭原有浏览器
  console.log('[Cleanup] Done (tab preserved)');
  await client.close();
}

async function runAll() {
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const username = ACCOUNTS[i];
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[Account ${i+1}/${ACCOUNTS.length}] ${username}`);
    console.log('='.repeat(50));
    try {
      await run(username);
      // Preserve the session when explicitly requested.
      if (process.env.JQ_KEEP_LOGIN !== '1') {
        await clearCookies();
        await sleep(3000);
      }
    } catch (err) {
      console.error(`[Error] Account ${username}:`, err.message);
      try { await clearCookies(); } catch(e) {}
    }
  }
  console.log('\n[DONE] All accounts processed.');
}

async function clearCookies() {
  // Use Network.clearBrowserCookies on any available port
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
      // Port is alive, use CDP to clear
      const CDP = require('chrome-remote-interface');
      CDP({ port: CDP_PORT }).then(async client => {
        await client.Network.enable();
        await client.Network.clearBrowserCookies();
        await client.close();
        console.log('[Cookies] Cleared');
        resolve();
      }).catch(reject);
    });
    req.on('error', () => resolve()); // Browser not running, nothing to clear
    req.end();
  });
}

runAll().then(() => {
  console.log('[Exit] Done, closing...');
  process.exit(0);
}).catch(err => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
