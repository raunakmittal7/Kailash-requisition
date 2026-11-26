import re, sys
src = open('/mnt/project-files/website/beta-v8.html', encoding='utf-8').read()
out = src
def rep(old, new, count=1):
    global out
    n = out.count(old)
    if n != count:
        sys.exit(f'Expected {count} match(es), found {n}: {old[:90]!r}')
    out = out.replace(old, new)

# --- head: Supabase client and settings
rep('<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>\n'
    '<script src="vendor/supabase-2.119.2.js"></script>\n<script src="config.js"></script>\n'
    '<link rel="manifest" href="manifest.webmanifest">')
rep('.beta{', '.syncbad{color:#b4231b;font-weight:600}\n.beta{')

# --- basics
rep("const uid=()=>Math.random().toString(36).slice(2,9);", "const uid=()=>crypto.randomUUID();")
rep("(async()=>{try{DL=(await window.claude?.use?.('downloads'))||null}catch(e){DL=null}})();",
    "DL={save:async({filename,data})=>{const u=URL.createObjectURL(new Blob([data]));const a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)}};")
rep("let S=null;\ntry{S=JSON.parse(localStorage.getItem(KEY))}catch(e){}\nfunction save(){try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}}",
    "let S=null;\nfunction save(){if(window.Live)Live.save()}")
rep("function nextNo(kind,sc){const k=kind+'-'+sc+'-'+YEAR;S.counters[k]=(S.counters[k]||0)+1;const n=String(S.counters[k]).padStart(3,'0');return kind==='po'?`KG/${sc}/PO/${YEAR}/${n}`:`KG/${sc}/${YEAR}/${n}`}",
    "/* The database gives the real number (KG/JAI/2026/001) as soon as it is saved. */\nfunction nextNo(kind,sc){return (kind==='po'?'New PO ':'New ')+uid().slice(0,4).toUpperCase()}")
rep("function log(text,ref,by,at){S.audit.unshift({at:at??now(),by:by??S.me,text,ref:ref||''})}",
    "function log(text,ref,by,at){S.audit.unshift({at:at??now(),by:by??S.me,text,ref:ref||''});window.Live&&Live.logged(text,ref||'')}")
rep("function send(toIds,text,kind,at,toText){S.outbox.unshift({at:at??now(),to:toText||toIds.map(uname).join(', '),text,kind})}",
    "function send(toIds,text,kind,at,toText){S.outbox.unshift({at:at??now(),to:toText||toIds.map(uname).join(', '),text,kind});window.Live&&Live.sent(toIds,text,kind,toText)}")
rep("function delegateOf(id){const d=S.deleg[id];", "function delegateOf(id){const d=S.deleg?.[id];")
rep("function targets(o,sc){if(o==='pm')return S.users.filter(u=>u.role==='pm')", "function targets(o,sc){if(o==='pm')return S.users.filter(u=>u.role==='pm'&&u.active!==false)")
rep("if(o==='store')return S.users.filter(u=>u.role==='store'&&u.site===sc)", "if(o==='store')return S.users.filter(u=>u.role==='store'&&u.site===sc&&u.active!==false)")

# --- remove the sample data generator
a = out.index('/* ---------- seed (sample data) ---------- */')
b = out.index('function makePO(')
out = out[:a] + out[b:]

# --- reminders only from office screens (storekeepers cannot mark them)
rep("function runReminders(){\n", "function runReminders(){\n  if(!me()||me().role==='store')return;\n")

# --- header: no beta banner; save status and account
rep("""  <div class="beta"><span>Beta preview with sample data. Nothing is sent to anyone, and changes stay on this device.</span><button class="linkbtn" onclick="A.resetAsk()">Reset sample data</button></div>\n""", "")
rep("""      <span class="small"><b>${esc(u.name)}</b> <span class="muted">· ${roleName(u)}</span></span>
      <button class="btn sm" onclick="A.logout()">Log out</button>""",
"""      <span id="syncst" class="small muted">${esc(Live.status())}</span>
      <span class="small"><b>${esc(u.name)}</b> <span class="muted">· ${roleName(u)}</span></span>
      <button class="btn sm" onclick="A.account()">My account</button>
      <button class="btn sm" onclick="A.logout()">Log out</button>""")
rep("function roleName(u){return u.role==='store'?'Storekeeper, '+site(u.site).name:u.role==='pm'?'Procurement':'Approver'}",
    "function roleName(u){return u.role==='store'?'Storekeeper, '+(site(u.site)?.name||u.site):u.role==='pm'?'Procurement':u.dbRole==='admin'?'Admin':'Approver'}")

# --- login
a = out.index('function loginView(){')
b = out.index('/* ---------- home ---------- */')
out = out[:a] + r'''function loginView(){
  return `<div class="login"><div class="lcard">
    <div class="logo"><b>KG</b><span>Kailasha Group</span></div>
    <div><h1>Log in</h1><p class="muted">Material requisitions for all projects</p></div>
    <label>Mobile number<input id="lg_mob" inputmode="numeric" maxlength="14" autocomplete="username" placeholder="10-digit mobile number" value="${esc(lg.mob)}"></label>
    <div class="seg"><button class="${lg.mode==='pw'?'on':''}" onclick="A.lgMode('pw')">Password</button><button class="${lg.mode==='otp'?'on':''}" onclick="A.lgMode('otp')">WhatsApp code</button></div>
    ${lg.mode==='pw'?`<label>Password<input id="lg_pw" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')A.loginPw()"></label><button class="btn primary" id="lg_go" onclick="A.loginPw()">Log in</button>`
    :`<p class="note info">Logging in with a WhatsApp code starts once WhatsApp is connected. For now, please log in with your password.</p>`}
    <p class="err" id="lg_err"></p>
    <p class="hint">Forgot your password? Ask Raunak to set a new one for you.</p>
  </div></div>`;
}

''' + out[b:]

# --- new requisition toast waits for the real number
rep("toast(`Sent. Number ${r.no}`);", "toast('Sending…');")

# --- requisition view
rep("const showQ=['quotes','final','issue','approved'].includes(r.stage)||Object.keys(r.quotes).length;",
    "const showQ=u.role!=='store'&&(['quotes','final','issue','approved'].includes(r.stage)||Object.keys(r.quotes).length);")
rep("""<button class="btn" onclick="A.sendBack('${r.id}')">Send back to storekeeper</button><button class="btn danger" onclick="A.reject('${r.id}')">Reject</button></div>`;
    if(r.stage==='final')""", """<button class="btn" onclick="A.sendBack('${r.id}')">Send back to storekeeper</button></div>`;
    if(r.stage==='final')""")

# --- PO view: storekeepers do not see rates
rep("function poRow(p){return `<button class=\"row\" onclick=\"A.go('po','${p.id}')\"><div class=\"main\"><div><span class=\"mono\">${p.no}</span> <span class=\"muted\">· ${esc(site(p.site).name)}</span></div><div class=\"small muted\">${esc(V(p.vendorId)?.name)} · ${esc(p.cat)}</div></div><div class=\"side\"><span class=\"small num\">${rs(poValue(p))}</span>",
    "function poRow(p){return `<button class=\"row\" onclick=\"A.go('po','${p.id}')\"><div class=\"main\"><div><span class=\"mono\">${p.no}</span> <span class=\"muted\">· ${esc(site(p.site)?.name)}</span></div><div class=\"small muted\">${esc(V(p.vendorId)?.name)} · ${esc(p.cat)}</div></div><div class=\"side\">${me()?.role==='store'?'':`<span class=\"small num\">${rs(poValue(p))}</span>`}")
rep("""    <div class="tw"><table><thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th><th class="num">Received</th></tr></thead>""",
    """    ${myStore||u.role==='store'?`<div class="tw"><table><thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Received</th></tr></thead><tbody>${p.lines.map((l,i)=>`<tr><td>${i+1}</td><td>${esc(l.name)}<small>${esc(l.brand)}${l.subUnit?' · '+esc(l.subUnit):''}</small></td><td class="num">${nf(l.qty)} ${esc(l.unit)}</td><td class="num">${nf(l.received)}<small>${l.received<l.qty?nf(l.qty-l.received)+' pending':'complete'}</small></td></tr>`).join('')}</tbody></table></div>`:`
    <div class="tw"><table><thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th><th class="num">Received</th></tr></thead>""")
rep("""<tr><td colspan="5">Total</td><td class="num">${rs(sub+gst)}</td><td></td></tr></tfoot></table></div>""",
    """<tr><td colspan="5">Total</td><td class="num">${rs(sub+gst)}</td><td></td></tr></tfoot></table></div>`}""")
rep('<p class="hint">In the full version this downloads as a PDF on the Kailasha Group letterhead, ready to send on WhatsApp or email.</p>',
    '<p class="hint">Downloading the purchase order as a PDF comes in the next update.</p>')
rep('<span class="chip info">Tally: waiting for connector</span>', '<span class="chip info">Tally: waiting for connector</span>')
rep('<p class="hint">These are sample vendors. Your real list will come from the Tally ledger export.</p>',
    '<p class="hint">The full vendor list can be loaded from the Tally ledger export.</p>')
rep("In the full version, Send opens WhatsApp or email with the PDF attached.", "Sending on WhatsApp starts once WhatsApp is connected. Until then, download the PDF and send it yourself.")

# --- settings: companies, people, PIN
rep("""      ${st.companies.map((c,ci)=>`<div class="grid"><label>Billing company ${st.companies.length>1?ci+1:''}<input value="${esc(c)}" data-s="${st.code}" data-i="${ci}" onchange="A.coName(this)"></label>""",
    """      ${st.companies.length?'':'<p class="small muted">No billing company yet.</p>'}${st.companies.map((c,ci)=>`<div class="grid"><label>Billing company ${st.companies.length>1?ci+1:''}<input value="${esc(c)}" data-s="${st.code}" data-i="${ci}" onchange="A.coName(this)"></label>""")
rep("""<label class="span2">Company address<input value="${esc(coInfo(c).address||'')}" data-c="${esc(c)}" onchange="A.coField(this,'address')"></label></div>`).join('')}</div>`).join('')}</section>""",
    """<label class="span2">Company address<input value="${esc(coInfo(c).address||'')}" data-c="${esc(c)}" onchange="A.coField(this,'address')"></label></div>`).join('')}<div class="actions"><button class="btn sm" data-s="${st.code}" onclick="A.coAdd(this)">+ Add billing company</button></div></div>`).join('')}</section>""")
rep("""  <section class="box"><div class="boxh"><h2>People</h2><button class="btn sm" onclick="A.userNew()">+ Add person</button></div>
    <div class="tw"><table><thead><tr><th>Name</th><th>Mobile</th><th>Role</th></tr></thead><tbody>${S.users.map(x=>`<tr><td>${esc(x.name)}</td><td class="mono">${esc(x.mobile)}</td><td>${roleName(x)}</td></tr>`).join('')}</tbody></table></div></section>""",
    """  <section class="box"><div class="boxh"><h2>People</h2>${Live.isBoss()?'<button class="btn sm" onclick="A.userNew()">+ Add person</button>':''}</div>
    <p class="small muted">Everyone logs in with their mobile number and password. ${Live.isBoss()?'When someone forgets their password, set a new one here and tell them.':'Only Raunak can add people or reset passwords.'}</p>
    <div class="tw"><table><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th></th></tr></thead><tbody>${S.users.map(x=>`<tr class="${x.active===false?'del':''}"><td>${esc(x.name)}${x.active===false?'<small>Switched off</small>':''}</td><td class="mono">${esc(x.mobile)}</td><td>${roleName(x)}</td><td style="white-space:nowrap;text-align:right">${Live.isBoss()&&x.uuid!==Live.uuid&&!['raunak','admin'].includes(x.dbRole)?`<button class="btn sm" onclick="A.pwReset('${x.uuid}')">New password</button> <button class="btn sm" onclick="A.userActive('${x.uuid}',${x.active===false})">${x.active===false?'Switch on':'Switch off'}</button>`:''}</td></tr>`).join('')}</tbody></table></div></section>""")

# --- actions
rep("A.lang=l=>{S.lang=l;render()};", "A.lang=l=>{S.lang=l;Live.setLang(l);render()};")
a = out.index("A.logout=()=>{")
b = out.index("/* draft editing */")
out = out[:a] + r'''A.logout=()=>{lg={mode:'pw',otp:null,mob:''};Live.logout()};
A.lgMode=m=>{lg.mob=val('lg_mob');lg.mode=m;render()};
const lgErr=m=>{const e=document.getElementById('lg_err');if(e)e.textContent=m};
A.loginPw=async()=>{let m=val('lg_mob').replace(/\D/g,'');if(m.length===12&&m.startsWith('91'))m=m.slice(2);lg.mob=m;
  if(m.length!==10)return lgErr('Enter your 10-digit mobile number.');const pw=val('lg_pw');if(!pw)return lgErr('Enter your password.');
  const b=document.getElementById('lg_go');if(b){b.disabled=true;b.textContent='Logging in…'}
  const err=await Live.login(m,pw);if(err){if(b){b.disabled=false;b.textContent='Log in'}lgErr(err)}};

''' + out[b:]
rep("""const res=await SAMPLE.json(slipPrompt(sc),{images:send.slice(0,SAMPLE_LIM||5)});""", """const res=await SAMPLE.json(slipPrompt(sc),{images:send.slice(0,SAMPLE_LIM||5)});""")
rep("function advance(r){const f=flowFor(r.site),i=f.indexOf(r.stage);r.stage=f[i+1];r.stageSince=now();if(r.stage==='quotes'&&refreshContractQuotes(r))",
    "function advance(r){const f=flowFor(r.site),i=f.indexOf(r.stage);r.stage=f[i+1];r.stageSince=now();if(r.stage==='quotes'&&Live.isBuyer()&&refreshContractQuotes(r))")
rep("push({id:'c_'+l.id+'_'+uid(),vendorId:l.vendorId,", "push({id:uid(),vendorId:l.vendorId,")
rep("""  r.stage='issue';A.issuePOs(id);
  send(targets('raunak'),""", """  r.stage='issue';r.stageSince=now();render();
  if(!(await Live.flush()))return;
  A.issuePOs(id);
  send(targets('raunak'),""")
rep("A.smallOrder=id=>{", "A.smallOrder=async id=>{")
rep("Enter your personal 4-digit PIN to reject. (Sample PIN: 1234)", "Enter your personal 4-digit PIN to reject.")
rep("""A.doReject=id=>{const r=R(id);if(val('pin')!==me().pin){document.getElementById('pinerr').textContent='Wrong PIN. Nothing was rejected.';return}""",
    """A.doReject=async id=>{const r=R(id),pe=document.getElementById('pinerr');if(!/^\\d{4}$/.test(val('pin'))){pe.textContent='Enter your 4-digit PIN.';return}
  if(!(await Live.flush()))return A.close();
  const {data,error}=await SB.rpc('reject_requisition',{p_req:id,p_pin:val('pin'),p_remarks:tmp.rj});
  if(error){pe.textContent=/Set your PIN/.test(error.message)?'You have not set a reject PIN yet. Set it under My account.':Live.errText(error);return}
  if(data==='wrong_pin'){pe.textContent='Wrong PIN. Nothing was rejected.';return}
  if(data==='locked'){pe.textContent='Too many wrong PINs. Rejecting is locked for 15 minutes.';return}""")

# companies and people (live)
rep("""A.coField=(el,f)=>{S.companyInfo=S.companyInfo||{};const c=el.dataset.c;(S.companyInfo[c]=S.companyInfo[c]||{})[f]=f==='gstin'?el.value.trim().toUpperCase():el.value.trim();log(`Updated ${f==='gstin'?'GSTIN':'address'} of ${c}`);save();toast('Saved')};""",
    """A.coField=(el,f)=>{const c=el.dataset.c,co=S._cos.find(x=>x.name===c);if(!co)return;const v=f==='gstin'?el.value.trim().toUpperCase():el.value.trim();if(f==='gstin'&&v&&!/^[0-9A-Z]{15}$/.test(v))return toast('A GSTIN has 15 letters and digits');co[f]=v;Live.rebuildCompanies();log(`Updated ${f==='gstin'?'GSTIN':'address'} of ${c}`);save();toast('Saved')};
A.coAdd=el=>{const sc=el.dataset.s;modal(`<h2>Add billing company</h2><p class="small muted">${esc(site(sc).name)}</p><label>Company name<input id="co_n"></label><label>GSTIN<input id="co_g" maxlength="15" style="text-transform:uppercase"></label><label>Company address<input id="co_a"></label><div class="mact"><button class="btn" onclick="A.close()">Cancel</button><button class="btn primary" onclick="A.doCoAdd('${sc}')">Add</button></div>`)};
A.doCoAdd=sc=>{const n=val('co_n').trim(),g=val('co_g').trim().toUpperCase();if(!n)return toast('Add the company name');if(g&&!/^[0-9A-Z]{15}$/.test(g))return toast('A GSTIN has 15 letters and digits');
  const ex=S._cos.find(x=>x.name.toLowerCase()===n.toLowerCase());if(ex){if(!ex.sites.includes(sc))ex.sites.push(sc)}else S._cos.push({id:uid(),name:n,gstin:g,address:val('co_a').trim(),sites:[sc]});
  Live.rebuildCompanies();log(`Added billing company ${n} for ${site(sc).name}`);A.close();render();toast('Company added')};""")
rep("""A.coName=el=>{const st=site(el.dataset.s),i=+el.dataset.i,old=st.companies[i],n=el.value.trim();if(!n||n===old)return;st.companies[i]=n;S.companyInfo=S.companyInfo||{};if(S.companyInfo[old]){S.companyInfo[n]=S.companyInfo[old];delete S.companyInfo[old]}""",
    """A.coName=el=>{const st=site(el.dataset.s),i=+el.dataset.i,old=st.companies[i],n=el.value.trim();if(!n||n===old)return;const co=S._cos.find(x=>x.name===old);if(co)co.name=n;Live.rebuildCompanies();""")
a = out.index("A.userNew=()=>modal(")
b = out.index("if(!S||S.v!==4) S=seed();")
out = out[:a] + r'''A.userNew=()=>modal(`<h2>Add person</h2><div class="grid"><label class="span2">Name<input id="un_n"></label><label>Mobile number<input id="un_m" inputmode="numeric" maxlength="10"></label><label>Role<select id="un_r" onchange="document.getElementById('un_sw').hidden=this.value!=='store'"><option value="store">Storekeeper</option><option value="pm">Procurement manager</option><option value="ajay">Approver: Ajay Agarwal</option><option value="ravi">Approver: Ravi Mittal</option></select></label><label id="un_sw">Site<select id="un_s">${S.sites.map(s=>`<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select></label><label class="span2">Starting password<input id="un_p" placeholder="At least 6 characters"></label></div><p class="hint">Tell them this password. They log in with their mobile number and can change it under My account.</p><p class="err" id="un_err"></p><div class="mact"><button class="btn" onclick="A.close()">Cancel</button><button class="btn primary" id="un_go" onclick="A.doUser()">Add</button></div>`);
A.doUser=async()=>{const n=val('un_n').trim(),m=val('un_m').replace(/\D/g,''),r=val('un_r'),p=val('un_p'),er=document.getElementById('un_err');
  if(!n||m.length!==10){er.textContent='Add a name and a 10-digit mobile number.';return}if(p.length<6){er.textContent='The starting password needs at least 6 characters.';return}
  document.getElementById('un_go').disabled=true;
  const {error}=await SB.rpc('add_person',{p_name:n,p_mobile:m,p_role:r,p_site:r==='store'?val('un_s'):null,p_password:p});
  if(error){er.textContent=Live.errText(error);document.getElementById('un_go').disabled=false;return}
  log('Added person '+n);A.close();await Live.reload();toast(n+' can now log in with '+m)};
A.pwReset=id=>{const x=S.users.find(u=>u.uuid===id);modal(`<h2>New password for ${esc(x.name)}</h2><label>New password<input id="pr_p" placeholder="At least 6 characters"></label><p class="hint">Tell them the new password. They can change it under My account.</p><p class="err" id="pr_err"></p><div class="mact"><button class="btn" onclick="A.close()">Cancel</button><button class="btn primary" onclick="A.doPwReset('${id}')">Save</button></div>`)};
A.doPwReset=async id=>{const p=val('pr_p');if(p.length<6){document.getElementById('pr_err').textContent='At least 6 characters.';return}
  const {error}=await SB.rpc('set_person_password',{p_person:id,p_password:p});if(error){document.getElementById('pr_err').textContent=Live.errText(error);return}
  log('Set a new password for '+S.users.find(u=>u.uuid===id).name);save();A.close();toast('Password changed')};
A.userActive=async(id,on)=>{const {error}=await SB.rpc('app_update',{p_table:'people',p_key:{id},p_set:{active:on}});if(error)return toast(Live.errText(error));log(`${on?'Switched on':'Switched off'} login for ${S.users.find(u=>u.uuid===id).name}`);await Live.reload();toast(on?'Login switched on':'Login switched off')};

/* My account: password and reject PIN */
A.account=()=>{const u=me(),appr=['ajay','ravi','raunak','admin'].includes(u.dbRole);modal(`<h2>My account</h2><p class="small muted">${esc(u.name)} · ${esc(u.mobile)}</p>
  <div class="sec" style="gap:8px"><h3>Change password</h3><label>New password<input id="ac_p" type="password" autocomplete="new-password" placeholder="At least 6 characters"></label><label>Type it again<input id="ac_p2" type="password" autocomplete="new-password"></label><div class="actions"><button class="btn primary sm" onclick="A.doPw()">Change password</button></div></div>
  ${appr?`<div class="sec" style="gap:8px"><h3>Reject PIN</h3><p class="small muted">4 digits, asked every time you reject a requisition. If you set one before, enter the old PIN too.</p><div class="grid"><label>Old PIN (if any)<input id="ac_o" type="password" inputmode="numeric" maxlength="4"></label><label>New PIN<input id="ac_n" type="password" inputmode="numeric" maxlength="4"></label></div><div class="actions"><button class="btn sm" onclick="A.doPin()">Save PIN</button></div></div>`:''}
  <p class="err" id="ac_err"></p><div class="mact"><button class="btn" onclick="A.close()">Close</button></div>`)};
A.doPw=async()=>{const p=val('ac_p'),e=document.getElementById('ac_err');if(p.length<6){e.textContent='The password needs at least 6 characters.';return}if(p!==val('ac_p2')){e.textContent='The two passwords are not the same.';return}
  const {error}=await SB.auth.updateUser({password:p});if(error){e.textContent=Live.errText(error);return}A.close();toast('Password changed')};
A.doPin=async()=>{const n=val('ac_n'),o=val('ac_o'),e=document.getElementById('ac_err');if(!/^\d{4}$/.test(n)){e.textContent='The PIN must be 4 digits.';return}
  const {error}=await SB.rpc('set_my_pin',{p_new:n,p_old:o||null});if(error){e.textContent=/Old PIN/.test(error.message)?'The old PIN is wrong.':Live.errText(error);return}A.close();toast('PIN saved')};

''' + out[b:]
rep("""if(!S||S.v!==4) S=seed();
if(!S.items) buildMaster();
if(!S.rateLists){S.rateLists=[];S.contractMap={}}
if(!S.cats.mfg.includes('Grocery & Ration')){const oi=S.cats.mfg.indexOf('Others');S.cats.mfg.splice(oi<0?S.cats.mfg.length:oi,0,'Grocery & Ration')}
window.addEventListener('keydown',e=>{if(e.key==='Escape')A.close()});
render();
</script>""", """window.addEventListener('keydown',e=>{if(e.key==='Escape')A.close()});
</script>
<script src="live.js"></script>
<script>Live.boot()</script>""")

# --- vendor sheet without HSN (Raunak, 2026-11-26)
rep("mention the GST % and HSN code for each item.", "mention the GST % for each item.")
rep("<th>Description of Goods</th><th>HSN/SAC</th><th>GST %</th>", "<th>Description of Goods</th><th>GST %</th>")
rep("""`<small style="white-space:pre-line">${esc(rfqDesc(it))}</small>`:''}</td><td></td><td></td><td class="num">""", """`<small style="white-space:pre-line">${esc(rfqDesc(it))}</small>`:''}</td><td></td><td class="num">""")
rep("""<tr><td></td><td><i>Freight / loading, if any</i></td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody>""", """<tr><td></td><td><i>Freight / loading, if any</i></td><td></td><td></td><td></td><td></td><td></td></tr></tbody>""")
rep("""<tfoot><tr><td></td><td>Total</td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tfoot>""", """<tfoot><tr><td></td><td>Total</td><td></td><td></td><td></td><td></td><td></td></tr></tfoot>""")
rep("""const body=d.items.map((it,i)=>[String(i+1),{content:it.name+(rfqDesc(it)?'\\n'+rfqDesc(it):''),styles:{}},'','',nf(it.qty)+' '+it.unit,'',it.unit,'']);""", """const body=d.items.map((it,i)=>[String(i+1),{content:it.name+(rfqDesc(it)?'\\n'+rfqDesc(it):''),styles:{}},'',nf(it.qty)+' '+it.unit,'',it.unit,'']);""")
rep("""body.push(['',{content:'Freight / loading, if any',styles:{fontStyle:'italic'}},'','','','','','']);""", """body.push(['',{content:'Freight / loading, if any',styles:{fontStyle:'italic'}},'','','','','']);""")
rep("""for(let i=0;i<blanks;i++)body.push(['','','','','','','','']);""", """for(let i=0;i<blanks;i++)body.push(['','','','','','','']);""")
rep("""head:[['Sl\\nNo','Description of Goods','HSN/SAC','GST %','Quantity','Rate','per','Amount']],""", """head:[['Sl\\nNo','Description of Goods','GST %','Quantity','Rate','per','Amount']],""")
rep("""body,foot:[['',{content:'Total',styles:{halign:'right'}},'','','','','','']],""", """body,foot:[['',{content:'Total',styles:{halign:'right'}},'','','','','']],""")
rep("""columnStyles:{0:{cellWidth:9,halign:'center'},1:{cellWidth:'auto'},2:{cellWidth:18},3:{cellWidth:13},4:{cellWidth:26,halign:'right'},5:{cellWidth:20,halign:'right'},6:{cellWidth:13},7:{cellWidth:24,halign:'right'}},""", """columnStyles:{0:{cellWidth:9,halign:'center'},1:{cellWidth:'auto'},2:{cellWidth:13},3:{cellWidth:26,halign:'right'},4:{cellWidth:20,halign:'right'},5:{cellWidth:13},6:{cellWidth:24,halign:'right'}},""")
rep("Please reply with your rate per unit, GST %, HSN and delivery time.", "Please reply with your rate per unit, GST % and delivery time.")

# --- full HTML document (the beta relied on the artifact viewer for this)
out = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + out
rep('</style>\n\n<div id="app"></div>', '</style>\n</head>\n<body>\n<div id="app"></div>')
out = out.rstrip() + '\n</body>\n</html>\n'

for bad in ['HSN', 'seed(', 'A.quick(', 'A.resetAsk', 'A.sendOtp', 'A.loginOtp', '.pin)', 'pass:']:
    if bad in out: print('WARNING still present:', bad)
open('/home/user/kailash-requisition/index.html', 'w', encoding='utf-8').write(out)
print('ok', len(out))
