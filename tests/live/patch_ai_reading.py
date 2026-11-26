# Applied to index.html after make_index_from_beta.py: reads slips/quotes through api/read.js, with clear "coming soon" text.
import re,sys
p=sys.argv[1];s=open(p,encoding='utf-8').read()
def rep(old,new):
    global s
    assert s.count(old)==1,(old[:60],s.count(old))
    s=s.replace(old,new)
rep("/* Claude reads vendor quotations (only inside the Claude viewer) */","/* Claude reads slips, quotations and price lists through the website's own server (api/read.js) */")
start=s.index("(async()=>{try{SAMPLE=(await window.claude?.use?.('sample'))")
end=s.index("\n",start)
s=s[:start]+r"""const b64Of=b=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]||'');r.onerror=()=>no({code:'image_rejected'});r.readAsDataURL(b)});
const SERVER_READ={limits:async()=>({images:{maxCount:5}}),async json(prompt,{images}={}){
  const imgs=[];let total=0;
  for(const b of (images||[]).slice(0,5)){const small=(b.size>700000||!/^image\/(jpeg|png|webp)$/.test(b.type))?(await shrinkImg(b,1600,.8)).blob:b;const data=await b64Of(small);if(total+data.length>3800000)break;total+=data.length;imgs.push({type:small.type||'image/jpeg',data})}
  const t=(await SB.auth.getSession()).data.session?.access_token||'';let r;
  try{r=await fetch('/api/read',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({prompt,images:imgs})})}catch(e){throw {code:'network'}}
  const j=await r.json().catch(()=>({}));if(!r.ok||!j.result)throw {code:j.error||(r.status===413?'too_big':'failed')};return j.result}};
(async()=>{try{const r=await fetch('/api/read',{cache:'no-store'});const j=await r.json();if(j?.ready){SAMPLE=SERVER_READ;SAMPLE_IMG=true;SAMPLE_LIM=5}}catch(e){SAMPLE=null}})();"""+s[end:]
SOON='Reading handwritten slips by photo is coming soon. For now, please fill the items by hand.'
rep("st.textContent='Reading slips is not available in this view. Please fill the items by hand.'","st.textContent='"+SOON+"'")
rep("const slipErr=e=>({not_granted:","const slipErr=e=>({not_configured:'"+SOON+"',network:'No internet connection. Check it and try again, or fill the items by hand.',too_big:'The photos are too large. Send fewer pages at a time.',not_granted:")
rep("toast('Automatic matching is not available in this view')","toast('Automatic matching with price lists is coming soon')")
rep("st.textContent='Reading price lists is not available in this view.'","st.textContent='Reading price lists automatically is coming soon. The file is not read yet, so please add the rates by hand.'")
rep("st.textContent='Automatic reading is not available here. The file is attached, so please type the rates below.'","st.textContent='Reading quotations automatically is coming soon. The file is attached, so please type the rates below.'")
rep("function qErrCopy(e){return ({not_granted:","function qErrCopy(e){return ({not_configured:'Reading quotations automatically is coming soon. The file is attached, so please type the rates below.',network:'No internet connection. Check it and try again, or type the rates below.',too_big:'The file is too large to read. Try fewer pages, or type the rates below.',not_granted:")
open(p,'w',encoding='utf-8').write(s)
print('ok')
