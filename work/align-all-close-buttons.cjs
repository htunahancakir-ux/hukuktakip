const fs=require('fs');const p='outputs/icrapro/app.js';fs.appendFileSync(p,`
function alignCloseButtons(){document.querySelectorAll('button').forEach(button=>{const text=button.textContent.trim().toLocaleLowerCase('tr');if(text==='kapat'||(text==='✕'||text==='×')&&/close/i.test(button.id)){button.classList.add('close-align-right');if(!button.getAttribute('aria-label'))button.setAttribute('aria-label','Kapat')}})}
const closeButtonObserver=new MutationObserver(alignCloseButtons);closeButtonObserver.observe(document.body,{childList:true,subtree:true});alignCloseButtons();
`);fs.appendFileSync('outputs/icrapro/style.css',`
.close-align-right{margin-left:auto!important;order:100;align-self:center;flex-shrink:0}
.panelhead>.toolbar:has(.close-align-right){order:99;margin-left:auto}
.panelhead>.borrower-sheet-navigation{order:50;margin-left:12px}
.toolbar>.close-align-right{order:100}
.actions:has(>.close-align-right){display:flex;justify-content:flex-end}
`);
