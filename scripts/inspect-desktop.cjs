const {chromium}=require('playwright');
const fs=require('fs');
(async()=>{const browser=await chromium.connectOverCDP('http://127.0.0.1:9224');const page=browser.contexts()[0].pages()[0];console.log('URL',page.url());console.log((await page.locator('body').innerText()).slice(0,7000));fs.mkdirSync('test-results/ui',{recursive:true});await page.screenshot({path:'test-results/ui/desktop.png'});await browser.close();})().catch(e=>{console.error(e);process.exit(1)});
