var manualLoginIntent=false;
// Codes are uppercase first names, de-duped with a numeric suffix (THOMAS2),
// so they can exceed 6 chars — allow up to 10 and grow the boxes to fit.
function sanitizeCode(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,10);}
function syncCodeBoxCount(len){
  var wrap=document.getElementById('codeBoxes');if(!wrap)return;
  var want=Math.max(6,len);
  while(wrap.children.length<want){var b=document.createElement('div');b.className='code-box';wrap.appendChild(b);}
  while(wrap.children.length>want){wrap.removeChild(wrap.lastChild);}
}
function renderCode(){
  var inp=document.getElementById('codeInput');if(!inp)return;
  var v=sanitizeCode(inp.value||'');if(inp.value!==v) inp.value=v;
  syncCodeBoxCount(v.length);
  var boxes=document.querySelectorAll('#codeBoxes .code-box');
  var active=v.length<boxes.length?v.length:-1;
  for(var i=0;i<boxes.length;i++){
    boxes[i].textContent=v.charAt(i)||'';
    boxes[i].classList.toggle('active',i===active);
    boxes[i].classList.toggle('filled',!!v.charAt(i));
  }
  var btn=document.getElementById('loginBtn');
  if(btn){btn.disabled=v.length<1;btn.classList.toggle('ready',v.length>0);}
  if(v.length>0) clearLoginError();
}
function handleCodePaste(event){
  event.preventDefault();
  var text=(event.clipboardData||window.clipboardData).getData('text');
  var inp=document.getElementById('codeInput');if(!inp)return;
  inp.value=sanitizeCode(text);renderCode();
  if(inp.value.length>=2) setTimeout(login,80);
}
function handleCodeKey(event){
  if(event.key==='Enter') login();
  if(event.key==='Backspace') clearLoginError();
}
function clearLoginError(){
  var card=document.getElementById('loginCard');if(card) card.classList.remove('login-error-shake');
  var err=document.getElementById('lerr');if(err) err.style.display='none';
}
function showLoginError(msg){
  var err=document.getElementById('lerr');if(err){err.textContent=msg||'Invalid code — check with your coach';err.style.display='block';}
  var card=document.getElementById('loginCard');if(card){card.classList.remove('login-error-shake');void card.offsetWidth;card.classList.add('login-error-shake');}
  var inp=document.getElementById('codeInput');if(inp) inp.focus();
}
function setLoginKeyboardState(active){
  var screen=document.getElementById('loginScreen');if(!screen)return;
  screen.classList.toggle('keyboard-open',!!active);
}
function syncLoginViewport(){
  var screen=document.getElementById('loginScreen');if(!screen||!window.visualViewport)return;
  var keyboardOpen=window.visualViewport.height < window.innerHeight*0.78;
  screen.classList.toggle('keyboard-open',keyboardOpen||document.activeElement===document.getElementById('codeInput'));
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',syncLoginViewport);
  window.visualViewport.addEventListener('scroll',syncLoginViewport);
}
function showLoginSuccess(name){
  var screen=document.getElementById('loginScreen');
  var nameEl=document.getElementById('loginSuccessName');
  if(nameEl) nameEl.textContent='Welcome, '+(name||'Athlete');
  if(screen){screen.classList.remove('keyboard-open');screen.classList.add('login-authed');}
}
function hideLoginSuccess(){
  var screen=document.getElementById('loginScreen');
  if(screen) screen.classList.remove('login-authed');
}
renderCode();

// ── EMAIL OTP LOGIN (migrated athletes) ──────────────────────────────────────
// Runs alongside the legacy code login above — nothing in the code path
// changes. Auth helpers (ensureSupabaseClient, resolveAuthedAthlete, doLogin)
// live in js/01-core.js (formerly app.js), which loads after this file; every reference here happens at
// interaction time, when they exist. OTP entry (not magic links) is deliberate:
// an installed PWA never has to survive a cross-app redirect.
var _emailFlow={email:'',cooldownTimer:null,cooldownLeft:0};

function loginScreenTap(event){
  // Tap-anywhere-to-focus, aimed at whichever panel is active. Ignore taps on
  // real controls so buttons/links keep working.
  var t=event&&event.target;
  if(t&&(t.tagName==='BUTTON'||t.tagName==='INPUT'||t.tagName==='A'))return;
  var emailVisible=isEmailPanelVisible();
  if(!emailVisible){var i=document.getElementById('codeInput');if(i){i.focus();renderCode();}return;}
  var otpVisible=document.getElementById('otpStep')&&document.getElementById('otpStep').style.display!=='none';
  var inp=document.getElementById(otpVisible?'otpInput':'emailInput');
  if(inp){inp.focus();if(otpVisible)renderOtp();}
}
function isEmailPanelVisible(){
  var el=document.getElementById('emailLogin');
  return !!el&&el.style.display!=='none';
}
function showEmailLogin(show,notice){
  var emailEl=document.getElementById('emailLogin'),codeEl=document.getElementById('codeLogin');
  var toggle=document.getElementById('loginMethodToggle');
  if(!emailEl||!codeEl)return;
  emailEl.style.display=show?'block':'none';
  codeEl.style.display=show?'none':'block';
  if(toggle)toggle.textContent=show?'Use an access code instead':'Sign in with email instead';
  clearEmailError();
  var noticeEl=document.getElementById('emailNotice');
  if(noticeEl){noticeEl.textContent=notice||'';noticeEl.style.display=notice?'block':'none';}
  if(show){
    showOtpStep(false);
    var remembered='';
    try{remembered=localStorage.getItem('dp_auth_email')||'';}catch(e){}
    var inp=document.getElementById('emailInput');
    if(inp&&!inp.value&&remembered)inp.value=remembered;
  }
}
function toggleLoginMethod(){showEmailLogin(!isEmailPanelVisible());}
function clearEmailError(){var e=document.getElementById('emailErr');if(e)e.style.display='none';}
function showEmailError(msg){
  var e=document.getElementById('emailErr');
  if(e){e.textContent=msg||'Something went wrong — try again';e.style.display='block';}
  var card=document.getElementById('loginCard');
  if(card){card.classList.remove('login-error-shake');void card.offsetWidth;card.classList.add('login-error-shake');}
}
function showOtpStep(show){
  var emailStep=document.getElementById('emailStep'),otpStep=document.getElementById('otpStep');
  if(emailStep)emailStep.style.display=show?'none':'block';
  if(otpStep)otpStep.style.display=show?'block':'none';
  clearEmailError();
  if(show){
    var sentTo=document.getElementById('otpSentTo');
    if(sentTo)sentTo.textContent='Code sent to '+_emailFlow.email;
    var inp=document.getElementById('otpInput');
    if(inp){inp.value='';renderOtp();setTimeout(function(){inp.focus();},60);}
  }else{
    if(_emailFlow.cooldownTimer){clearInterval(_emailFlow.cooldownTimer);_emailFlow.cooldownTimer=null;}
  }
}
function sanitizeOtp(v){return String(v||'').replace(/[^0-9]/g,'').slice(0,6);}
function renderOtp(){
  var inp=document.getElementById('otpInput');if(!inp)return;
  var v=sanitizeOtp(inp.value||'');if(inp.value!==v)inp.value=v;
  var boxes=document.querySelectorAll('#otpBoxes .code-box');
  var active=v.length<boxes.length?v.length:-1;
  for(var i=0;i<boxes.length;i++){
    boxes[i].textContent=v.charAt(i)||'';
    boxes[i].classList.toggle('active',i===active);
    boxes[i].classList.toggle('filled',!!v.charAt(i));
  }
  var btn=document.getElementById('otpVerifyBtn');
  if(btn){btn.disabled=v.length!==6;btn.classList.toggle('ready',v.length===6);}
  if(v.length===6)verifyEmailCode(); // auto-submit on the 6th digit
}
function handleOtpPaste(event){
  event.preventDefault();
  var text=(event.clipboardData||window.clipboardData).getData('text');
  var inp=document.getElementById('otpInput');if(!inp)return;
  inp.value=sanitizeOtp(text);renderOtp();
}
function startResendCooldown(seconds){
  var btn=document.getElementById('otpResendBtn');if(!btn)return;
  _emailFlow.cooldownLeft=seconds;
  btn.disabled=true;
  if(_emailFlow.cooldownTimer)clearInterval(_emailFlow.cooldownTimer);
  _emailFlow.cooldownTimer=setInterval(function(){
    _emailFlow.cooldownLeft--;
    if(_emailFlow.cooldownLeft<=0){
      clearInterval(_emailFlow.cooldownTimer);_emailFlow.cooldownTimer=null;
      btn.disabled=false;btn.textContent='Resend code';
    }else{
      btn.textContent='Resend code ('+_emailFlow.cooldownLeft+'s)';
    }
  },1000);
  btn.textContent='Resend code ('+seconds+'s)';
}
async function sendEmailCode(isResend){
  var inp=document.getElementById('emailInput');
  var email=(isResend&&_emailFlow.email)||String((inp&&inp.value)||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showEmailError('Enter a valid email address');return;}
  if(typeof ensureSupabaseClient!=='function'){showEmailError('Portal is still loading — try again in a second');return;}
  var btn=document.getElementById(isResend?'otpResendBtn':'emailSendBtn');
  var btnLabel=btn?btn.textContent:'';
  if(btn){btn.disabled=true;btn.textContent=isResend?'Sending…':'Sending Code…';}
  function resetBtn(){if(btn){btn.disabled=false;btn.textContent=btnLabel;}}
  clearEmailError();
  try{
    // Server-side gate BEFORE any OTP send: global env flag + per-athlete
    // enrolment. Stops stray auth users being created for unknown emails and
    // gives non-migrated athletes a clear pointer back to their code.
    var elig=await fetch('/api/auth-athlete?action=eligibility&email='+encodeURIComponent(email),{cache:'no-store'}).then(function(r){return r.json();}).catch(function(){return null;});
    if(!elig||elig.ok===false){resetBtn();showEmailError('Could not check your email — try again');return;}
    if(!elig.enabled){resetBtn();showEmailError('Email sign-in isn’t switched on yet — use your access code');return;}
    if(!elig.eligible){resetBtn();showEmailError('This email isn’t set up for sign-in — use your access code or ask your coach');return;}
    var client=await ensureSupabaseClient();
    if(!client||!client.auth){resetBtn();showEmailError('Connection problem — try again');return;}
    var res=await client.auth.signInWithOtp({email:email,options:{shouldCreateUser:true}});
    if(res.error){
      resetBtn();
      var m=String(res.error.message||'');
      // Supabase's inter-request cooldown ("you can only request this after N
      // seconds") is not a failure — tell the athlete to wait, not to panic.
      if(/security purposes|after \d+ seconds/i.test(m))showEmailError('One moment — wait a few seconds, then tap resend once');
      else if(/rate|too many/i.test(m))showEmailError('Too many codes requested — wait a minute and try again');
      else showEmailError('Could not send the code — try again');
      return;
    }
    _emailFlow.email=email;
    try{localStorage.setItem('dp_auth_email',email);}catch(e){}
    resetBtn();
    showOtpStep(true);
    startResendCooldown(30);
  }catch(e){resetBtn();showEmailError('Could not send the code — check your connection');}
}
async function verifyEmailCode(){
  var inp=document.getElementById('otpInput');
  var token=sanitizeOtp(inp&&inp.value);
  if(token.length!==6||!_emailFlow.email)return;
  var btn=document.getElementById('otpVerifyBtn');
  if(btn&&btn.classList.contains('loading'))return; // guard double-submit (auto + Enter)
  if(btn){btn.disabled=true;btn.classList.add('loading');btn.textContent='Verifying…';}
  function resetBtn(label){if(btn){btn.disabled=false;btn.classList.remove('loading');btn.textContent=label||'Verify & Enter';}}
  clearEmailError();
  try{
    var client=await ensureSupabaseClient();
    if(!client||!client.auth){resetBtn();showEmailError('Connection problem — try again');return;}
    var res=await client.auth.verifyOtp({email:_emailFlow.email,token:token,type:'email'});
    if(res.error||!res.data||!res.data.session){
      resetBtn();
      var m=String((res.error&&res.error.message)||'');
      if(/expired/i.test(m))showEmailError('That code has expired — tap “Resend code” for a new one');
      else showEmailError('That code didn’t match — check the digits or resend');
      if(inp){inp.value='';renderOtp();}
      return;
    }
    // Session established. Set the token directly (the onAuthStateChange
    // listener also sets it, but may fire a tick later), then resolve — and on
    // first sign-in, link — the athlete server-side, and enter through the
    // SAME pipeline as a code login so portal, history and sync are identical.
    _authToken=res.data.session.access_token;
    var me=await resolveAuthedAthlete();
    if(!me||me.ok===false||!me.code){
      await authSignOut();
      resetBtn();
      if(me&&me.error==='no_linked_athlete')showEmailError('Signed in, but this email isn’t linked to an athlete yet — ask your coach');
      else showEmailError('Could not load your athlete profile — try again');
      return;
    }
    if(me.active===false){resetBtn();showPausedScreen(me.name);return;}
    try{localStorage.setItem('dp_auth_method','email');}catch(e){}
    showLoginSuccess(me.name);
    resetBtn();
    doLogin(me.code); // me.code === the athlete's original code → full history
  }catch(e){resetBtn();showEmailError('Verification failed — try again');}
}
