const http=require('node:http');
const {createApplication}=require('../../lib/application.cjs');
const {createPool,createStore}=require('../../lib/postgres-store.cjs');
const handler=createApplication({store:process.env.DATABASE_URL?createStore(createPool()):undefined});
http.createServer(handler).listen(Number(process.env.HANHUKUK_PORT||4317),'127.0.0.1',()=>console.log('Han Hukuk ready'));
