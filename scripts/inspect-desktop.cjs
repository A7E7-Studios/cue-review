// Prints what a running test app (local CDP port 9224) shows: URL, theme, window chrome and visible text,
// and saves test-results/ui/desktop.png. Read-only: it clicks nothing.
const {chromium}=require('playwright');
const fs=require('fs');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.CUEREVIEW_CDP||'http://127.0.0.1:9224');const page=browser.contexts()[0].pages()[0];
 console.log('URL',page.url());
 console.log(JSON.stringify(await page.evaluate(()=>{
  const bar=document.querySelector('[aria-label="Title bar"],[aria-label="Toolbar"]');
  return{theme:document.documentElement.dataset.theme,size:{width:innerWidth,height:innerHeight},chrome:bar&&{name:bar.getAttribute('aria-label'),controls:[...bar.querySelectorAll('button,input')].map(item=>item.getAttribute('aria-label')||item.textContent.trim())},heading:document.querySelector('h1')?.textContent.trim()};
 }),null,2));
 console.log((await page.locator('body').innerText()).slice(0,7000));
 fs.mkdirSync('test-results/ui',{recursive:true});await page.screenshot({path:'test-results/ui/desktop.png'});await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
