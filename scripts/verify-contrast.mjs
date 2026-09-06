import { chromium } from 'playwright';
const b=await chromium.launch();
const out={};
const rgb=s=>{const t=String(s);const m=(t.match(/[\d.]+/g)||[]).slice(0,3).map(Number);return /^color\(/.test(t)?m.map(v=>v*255):m;};
const lum=c=>{const[r,g,bb]=rgb(c).map(v=>{v/=255;return v>0.03928?((v+0.055)/1.055)**2.4:v/12.92});return .2126*r+.7152*g+.0722*bb};
const contrast=(f,bg)=>{const a=lum(f),d=lum(bg);return +(((Math.max(a,d)+.05)/(Math.min(a,d)+.05)).toFixed(2))};
// Composite an rgba foreground over its background before measuring.
const flatten=(fg,bg)=>{const m=String(fg).match(/[\d.]+/g)||[];const a=m.length>3?+m[3]:1;
  const F=m.slice(0,3).map(Number),B=rgb(bg);return `rgb(${F.map((v,i)=>Math.round(v*a+B[i]*(1-a))).join(',')})`;};

for (const [w,h,theme] of [[1440,900,'dark'],[1440,900,'light'],[390,844,'dark'],[390,844,'light']]) {
  const key=`${w===1440?'desktop':'mobile'}-${theme}`;
  const c=await b.newContext({viewport:{width:w,height:h}});
  await c.addInitScript(()=>{try{sessionStorage.setItem('dp_dashboard_key','preview');sessionStorage.setItem('dp_dashboard_coach','KARL')}catch{}});
  const p=await c.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  p.on('console',m=>{if(m.type()==='error'&&!/ERR_CONNECTION|ERR_FAILED/.test(m.text()))errs.push(m.text().slice(0,120))});
  await p.goto('http://localhost:4173/index.html',{waitUntil:'networkidle'});
  await p.evaluate(()=>document.fonts.ready);
  await p.evaluate(t=>document.body.setAttribute('data-theme',t),theme);
  await p.waitForTimeout(1600);
  const r=await p.evaluate(()=>{
    const probe=n=>{const s=document.createElement('span');s.style.cssText=`color:var(${n});position:absolute;visibility:hidden`;document.body.appendChild(s);const v=getComputedStyle(s).color;s.remove();return v};
    const meas=f=>{const s=document.createElement('span');s.textContent='HANDLEBAR MEASUREMENT 0123456789';s.style.cssText=`font:700 40px ${f};position:absolute;visibility:hidden;white-space:nowrap`;document.body.appendChild(s);const x=Math.round(s.getBoundingClientRect().width);s.remove();return x};
    // Sample every small/muted text node actually on screen for the contrast audit.
    const samples=[];
    document.querySelectorAll('body *').forEach(el=>{
      const rc=el.getBoundingClientRect(); if(!rc.width||!rc.height) return;
      if(!el.textContent.trim() || el.children.length) return;
      const cs=getComputedStyle(el);
      // Composite the whole background stack, not just the nearest colour.
      // Half the UI paints with translucent fills (rgba(255,255,255,.2) chips
      // on a dark bar), and treating one of those as the background produced
      // impossible 1:1 ratios: white text measured against white-at-20%
      // instead of against what that fill actually resolves to over the bar
      // beneath it. Layers are collected outward and flattened back inward.
      const layers=[];
      let node=el, opaque=null, hasImage=false;
      while(node){
        const ns=getComputedStyle(node);
        if(ns.backgroundImage && ns.backgroundImage!=='none'){ hasImage=true; break; }
        const col=ns.backgroundColor||'';
        let parts=(col.match(/[\d.]+/g)||[]).map(Number);
        // color(srgb ...) has 0-1 components; rgb() has 0-255. Reading the
        // former as the latter turned near-white backgrounds into near-black
        // and invented contrast failures.
        if(/^color\(/.test(col)) parts=parts.map((v,i)=>i<3?v*255:v);
        const alpha=parts.length>3?parts[3]:(parts.length?1:0);
        if(alpha>0){
          if(alpha>=1){ opaque=parts.slice(0,3); break; }
          layers.push({rgb:parts.slice(0,3), a:alpha});
        }
        node=node.parentElement;
      }
      // A gradient or image behind the text cannot be measured numerically.
      if(hasImage || !opaque) return;
      let base=opaque;
      for(let i=layers.length-1;i>=0;i--){
        const L=layers[i];
        base=[0,1,2].map(k=>L.rgb[k]*L.a + base[k]*(1-L.a));
      }
      const bg=`rgb(${base.map(v=>Math.round(v)).join(',')})`;
      samples.push({cls:(el.className||'').toString().slice(0,28),size:parseFloat(cs.fontSize),weight:cs.fontWeight,color:cs.color,bg});
    });
    return {
      run:probe('--run'), str:probe('--str'), dim:probe('--dim'), muted:probe('--muted'),
      surface:probe('--surface'), text:probe('--text'),
      cond:meas(`'IBM Plex Sans Condensed',sans-serif`), sans:meas(`'IBM Plex Sans',sans-serif`), generic:meas('sans-serif'),
      contentMax:getComputedStyle(document.body).getPropertyValue('--content-max').trim(),
      overflow:document.documentElement.scrollWidth>window.innerWidth+1,
      emoji:(document.body.innerText.match(/[\u{1F300}-\u{1FAFF}]/gu)||[]).length,
      icons:document.querySelectorAll('svg.dp-icon').length,
      skipLink:!!document.querySelector('.dp-skip-link'),
      liveRegion:!!document.querySelector('#dp-live-region[aria-live]'),
      samples,
    };
  });
  const lab=([r,g,bb])=>{const f=c=>{c/=255;return c>0.04045?((c+0.055)/1.055)**2.4:c/12.92};const[R,G,B]=[f(r),f(g),f(bb)];
    const X=(R*.4124+G*.3576+B*.1805)/.95047,Y=R*.2126+G*.7152+B*.0722,Z=(R*.0193+G*.1192+B*.9505)/1.08883;
    const g2=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;return[116*g2(Y)-16,500*(g2(X)-g2(Y)),200*(g2(Y)-g2(Z))]};
  const dE=(x,y)=>{const A=lab(rgb(x)),B2=lab(rgb(y));return +Math.sqrt(A.reduce((s,v,i)=>s+(v-B2[i])**2,0)).toFixed(1)};
  // WCAG AA: 4.5 for body text, 3.0 for >=18.66px bold or >=24px.
  const fails=r.samples.map(s=>{
    const fg=flatten(s.color,s.bg); const ratio=contrast(fg,s.bg);
    const large=s.size>=24||(s.size>=18.66&&+s.weight>=700);
    return {...s, ratio, need:large?3:4.5, pass:ratio>=(large?3:4.5)};
  }).filter(s=>!s.pass);
  out[key]={runStrDeltaE:dE(r.run,r.str), condensedApplied:r.cond<r.sans-8, sansReal:Math.abs(r.sans-r.generic)>2,
    contentMax:r.contentMax, overflow:r.overflow, emoji:r.emoji, icons:r.icons,
    skipLink:r.skipLink, liveRegion:r.liveRegion, errors:errs.length,
    textSampled:r.samples.length, contrastFailures:fails.length,
    worst:fails.sort((a,b)=>a.ratio-b.ratio).slice(0,30).map(f=>`${f.cls||'(bare)'} ${f.size}px ${f.ratio}:1 need ${f.need}`)};
  await p.screenshot({path:`/tmp/vout/final-${key}.png`});
  await c.close();
}
await b.close();
for(const [k,v] of Object.entries(out)){
  console.log('\n== '+k);
  console.log('   run/str ΔE', v.runStrDeltaE, '| condensed', v.condensedApplied, '| sans real', v.sansReal, '| width', v.contentMax);
  console.log('   overflow', v.overflow, '| emoji', v.emoji, '| svg icons', v.icons, '| skipLink', v.skipLink, '| live', v.liveRegion, '| errors', v.errors);
  console.log('   contrast: '+v.contrastFailures+' fails of '+v.textSampled+' text nodes');
  v.worst.forEach(w=>console.log('      '+w));
}
