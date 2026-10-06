import { Client } from 'pg';
const c = new Client({ connectionString: process.env.PW_URL!, connectionTimeoutMillis: 15000 });
for (let i=0;i<25;i++){try{await c.connect();break;}catch{await new Promise(r=>setTimeout(r,3000));}}
const q = async (s: string) => { for(let i=0;i<10;i++){try{return await c.query(s);}catch(e){console.error(' err',(e as Error).message.slice(0,60));await new Promise(r=>setTimeout(r,3000));}} throw new Error('f'); };
const r = await q(`select artist, album_artist, count(*)::int as n from tracks where album='PRETTY DOLLCORPSE' group by 1,2 order by 3 desc`);
console.log('rows:', r.rows.length);
for (const x of r.rows) {
  console.log('  n=' + String(x.n) + '  artist=' + JSON.stringify(x.artist));
  console.log('            aartist=' + JSON.stringify(x.album_artist));
}
await c.end();
