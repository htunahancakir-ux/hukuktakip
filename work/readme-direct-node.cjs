const fs=require('fs');const p='README.md';let s=fs.readFileSync(p,'utf8');s=s.replace('npm start','node outputs/icrapro/server.cjs').replace('npm test','node tests/run.cjs');fs.writeFileSync(p,s);
