const fs=require('fs');const p='outputs/icrapro/dashboard.js';let s=fs.readFileSync(p,'utf8');s=s.replaceAll(",['Kâr',borrowerProfit(d)]",'');fs.writeFileSync(p,s);
