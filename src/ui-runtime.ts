// Declarative-UI runtime for render_ui. Original lean port of the concepts in
// thesysdev/open-intelligent-ui (MIT, Copyright (c) 2026 Thesys Inc.), commit
// 03213439358bf3408ad61a46ec9e3230c5572e48: component set from src/lib/library.ts,
// function library semantics from src/lib/functions/* (bad args evaluate to null),
// actions from src/lib/actions.ts. No upstream code is copied verbatim; the spec
// format, parser and renderer are LocalWORK's. See NOTICE.md.
//
// Security: the runtime never uses eval/new Function/innerHTML. Expressions are parsed
// and interpreted from an AST with a whitelisted function table. All spec data reaches
// the DOM through createElement/textContent/setAttribute only. It must stay free of the
// literal sequences "</script" and "<!--" and of backticks / dollar-brace, because it
// is embedded in an inline <script> and in a TS template literal.

export const UI_RUNTIME_CSS = `
[hidden]{display:none!important}
.lw-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.lw-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;min-width:0}
.lw-grid{display:grid;gap:12px;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr))}
@media(max-width:520px){.lw-grid{grid-template-columns:minmax(0,1fr)}}
.lw-card{border:.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);padding:14px 16px;background:var(--color-background-primary)}
.lw-ct{font-weight:500;font-size:15px}
.lw-title{font-size:22px;font-weight:500;line-height:1.3}
.lw-text{line-height:1.6}
.lw-cap{font-size:12px;color:var(--color-text-secondary);line-height:1.4}
.lw-badge{display:inline-block;font-size:12px;padding:2px 10px;border-radius:99px;background:var(--color-background-secondary);color:var(--color-text-secondary)}
.lw-badge.info{background:var(--color-background-info);color:var(--color-text-info)}
.lw-badge.success{background:var(--color-background-success);color:var(--color-text-success)}
.lw-badge.warning{background:var(--color-background-warning);color:var(--color-text-warning)}
.lw-badge.danger{background:var(--color-background-danger);color:var(--color-text-danger)}
.lw-hr{border:0;border-top:.5px solid var(--color-border-tertiary);width:100%}
.lw-list{padding-left:22px;line-height:1.6}
.lw-code{font:13px/1.5 var(--font-mono);background:var(--color-background-secondary);border-radius:8px;padding:10px 12px;overflow:auto;white-space:pre}
.lw-md{display:flex;flex-direction:column;gap:8px;line-height:1.6}
.lw-md code{font:13px var(--font-mono);background:var(--color-background-secondary);padding:1px 5px;border-radius:4px}
.lw-md ul,.lw-md ol{padding-left:22px}
.lw-lnk{color:var(--color-text-info);text-decoration:underline}
.lw-h{font-weight:500;font-size:16px}
.lw-f{display:flex;flex-direction:column;gap:4px;font-size:14px;min-width:0}
.lw-fl{font-size:13px;color:var(--color-text-secondary)}
.lw-val{margin-left:6px;color:var(--color-text-primary)}
.lw-f input[type=range]{width:100%;margin:10px 0}
.lw-ck,.lw-rl{display:flex;align-items:center;gap:8px;font-size:14px}
.lw-radio{display:flex;flex-direction:column;gap:6px}
.lw-seg{display:inline-flex;border:.5px solid var(--color-border-secondary);border-radius:8px;overflow:hidden;align-self:flex-start}
.lw-seg button{border:0;border-radius:0}
.lw-on{background:var(--color-background-secondary);font-weight:500}
.lw-pri{background:var(--color-text-primary);color:var(--color-background-primary)}
.lw-pri:hover{background:var(--color-text-primary);opacity:.85}
.lw-stat{display:flex;flex-direction:column;gap:2px;padding:12px 14px;background:var(--color-background-secondary);border-radius:var(--border-radius-md);min-width:0}
.lw-big{font-size:24px;font-weight:500;line-height:1.2}
.lw-up{color:var(--color-text-success);font-size:13px}
.lw-dn{color:var(--color-text-danger);font-size:13px}
.lw-bar{height:8px;border-radius:4px;background:var(--color-background-tertiary);overflow:hidden}
.lw-bar>div{height:100%;background:var(--color-text-info);border-radius:4px;transition:width .2s}
.lw-tw{overflow:auto;max-width:100%}
.lw-t{border-collapse:collapse;width:100%;font-size:14px}
.lw-t th{text-align:left;font-weight:500;padding:6px 10px;border-bottom:.5px solid var(--color-border-secondary);white-space:nowrap}
.lw-t th.lw-s{cursor:pointer;user-select:none}
.lw-t td{padding:5px 10px;border-bottom:.5px solid var(--color-border-tertiary)}
.lw-t .lw-n{text-align:right;font-variant-numeric:tabular-nums}
.lw-tb{display:flex;flex-wrap:wrap;gap:4px;border-bottom:.5px solid var(--color-border-tertiary);margin-bottom:12px}
.lw-tb button{border:0;border-radius:8px 8px 0 0;border-bottom:2px solid transparent}
.lw-tb .lw-on{border-bottom-color:var(--color-text-info);background:transparent}
.lw-chart svg{display:block;width:100%;height:auto}
.lw-gl{stroke:var(--color-border-tertiary);stroke-width:1}
.lw-leg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--color-text-secondary);margin-top:4px}
.lw-sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.lw-fc{display:block;width:100%;min-height:96px;padding:18px;text-align:center;font-size:17px;border-radius:var(--border-radius-lg);background:var(--color-background-secondary)}
.lw-timer{display:flex;align-items:center;gap:10px}
.lw-svg{color:var(--color-text-primary)}
.lw-err{font-size:13px;padding:6px 10px;border-radius:8px;background:var(--color-background-danger);color:var(--color-text-danger)}
.lw-toast{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 14px;border-radius:8px;background:var(--color-text-primary);color:var(--color-background-primary);font-size:13px}
`;

export const UI_RUNTIME_JS = String.raw`
var LW=(function(){
"use strict";
var DOC=null,S={},INIT={},FX=[],busy=false,errs=[],ER=null,uid=0,depth=0;
var BAD={__proto__:1,constructor:1,prototype:1};
var NAME=/^[A-Za-z_]\w*$/;
function own(o,k){return o!=null&&Object.prototype.hasOwnProperty.call(o,k)}
function isNum(x){return typeof x==='number'&&isFinite(x)}
function N(x){if(isNum(x))return x;if(x==null||x===''||x===false)return 0;if(x===true)return 1;return Number(x)}
function num1(x){return isNum(x)?x:null}
function arr(a){return Array.isArray(a)?a:a==null?[]:[a]}
function clone(v){return v===undefined?null:JSON.parse(JSON.stringify(v))}
function show(v){if(v==null)return '';if(typeof v==='number')return isFinite(v)?String(parseFloat(v.toPrecision(12))):'';if(Array.isArray(v))return v.map(show).join(', ');if(typeof v==='object')return JSON.stringify(v);return String(v)}
function get(o,p){if(p==null)return o;String(p).split('.').forEach(function(k){o=o!=null&&typeof o==='object'&&!BAD[k]&&own(o,k)?o[k]:null});return o}
function p2(n){return (n<10?'0':'')+n}

/* ---------- expression language: lexer, parser, interpreter (no eval) ---------- */
function lex(s){var t=[],i=0,m,c,r;
  while(i<s.length){c=s[i];r=s.slice(i);
    if(/\s/.test(c)){i++;continue}
    if(m=/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(r)){t.push({k:'n',v:parseFloat(m[0])});i+=m[0].length;continue}
    if(c==='"'||c==="'"){var j=i+1,o='';while(j<s.length&&s[j]!==c){if(s[j]==='\\'){j++;o+=s[j]==='n'?'\n':(s[j]||'')}else o+=s[j];j++}
      if(j>=s.length)throw Error('unterminated string');t.push({k:'s',v:o});i=j+1;continue}
    if(m=/^\$[A-Za-z_]\w*/.exec(r)){t.push({k:'v',v:m[0].slice(1)});i+=m[0].length;continue}
    if(m=/^[A-Za-z_]\w*/.exec(r)){t.push({k:'i',v:m[0]});i+=m[0].length;continue}
    if(m=/^(===|!==|==|!=|<=|>=|&&|\|\||\?\?|[-+*\/%<>!?:.,()\[\]{}])/.exec(r)){t.push({k:'o',v:m[0]});i+=m[0].length;continue}
    throw Error('unexpected character '+c)}
  return t}
var LV=[['??'],['||'],['&&'],['==','!=','===','!=='],['<','>','<=','>='],['+','-'],['*','/','%']];
function parse(src){var t=lex(src),p=0;
  function pk(v){return p<t.length&&t[p].k==='o'&&t[p].v===v}
  function eat(v){if(!pk(v))throw Error('expected '+v);p++}
  function tern(){var c=bin(0);if(pk('?')){p++;var a=tern();eat(':');return ['t',c,a,tern()]}return c}
  function bin(l){if(l>=LV.length)return un();var x=bin(l+1);while(p<t.length&&t[p].k==='o'&&LV[l].indexOf(t[p].v)>=0){var o=t[p++].v;x=['b',o,x,bin(l+1)]}return x}
  function un(){if(pk('!')||pk('-')||pk('+')){var o=t[p++].v;return ['u',o,un()]}return post()}
  function list(end){var a=[];if(!pk(end)){do{a.push(tern())}while(pk(',')&&++p)}eat(end);return a}
  function post(){var x=prim();for(;;){
    if(pk('.')){p++;var k=t[p++];if(!k||k.k!=='i')throw Error('bad member');x=['m',x,['n',k.v]]}
    else if(pk('[')){p++;var e=tern();eat(']');x=['m',x,e]}
    else if(pk('(')){if(x[0]!=='i')throw Error('only named functions can be called');p++;x=['c',x[1],list(')')]}
    else return x}}
  function prim(){var k=t[p++];if(!k)throw Error('unexpected end');
    if(k.k==='n'||k.k==='s')return ['n',k.v];
    if(k.k==='v')return ['v',k.v];
    if(k.k==='i')return ['i',k.v];
    if(k.v==='('){var e=tern();eat(')');return e}
    if(k.v==='[')return ['a',list(']')];
    if(k.v==='{'){var o=[];if(!pk('}')){do{var q=t[p++];if(!q||q.k==='o')throw Error('bad object key');eat(':');o.push([String(q.v),tern()])}while(pk(',')&&++p)}eat('}');return ['o',o]}
    throw Error('unexpected '+k.v)}
  var r=tern();if(p<t.length)throw Error('unexpected '+t[p].v);return r}
function mem(o,k){if(o==null||BAD[k])return null;
  if(typeof o==='string')return k==='length'?o.length:isNum(k)&&k>=0&&k<o.length?o[k]:null;
  if(Array.isArray(o)){if(k==='length')return o.length;if(isNum(k)){var i=k<0?o.length+k:k;return i>=0&&i<o.length?o[i]:null}return null}
  return typeof o==='object'&&own(o,k)?o[k]:null}
function call(name,args,L){if(!own(F,name))throw Error('unknown function '+name);
  var a=args.map(function(x){return ev(x,L)});
  try{var r=F[name].apply(null,a);return r===undefined||(typeof r==='number'&&!isFinite(r))?null:r}catch(e){return null}}
function ev(a,L){switch(a[0]){
  case 'n':return a[1];
  case 'v':return own(S,a[1])?S[a[1]]:null;
  case 'i':{var n=a[1];if(n==='true')return true;if(n==='false')return false;if(n==='null'||n==='undefined')return null;return L&&own(L,n)?L[n]:null}
  case 'a':return a[1].map(function(x){return ev(x,L)});
  case 'o':{var o={};a[1].forEach(function(kv){if(!BAD[kv[0]])o[kv[0]]=ev(kv[1],L)});return o}
  case 't':return ev(a[1],L)?ev(a[2],L):ev(a[3],L);
  case 'u':{var x=ev(a[2],L);return a[1]==='!'?!x:num1(a[1]==='-'?-N(x):N(x))}
  case 'm':return mem(ev(a[1],L),ev(a[2],L));
  case 'c':return call(a[1],a[2],L);
  case 'b':{var op=a[1],l=ev(a[2],L);
    if(op==='&&')return l?ev(a[3],L):l;if(op==='||')return l?l:ev(a[3],L);if(op==='??')return l!=null?l:ev(a[3],L);
    var y=ev(a[3],L);
    switch(op){
      case '+':if(typeof l==='string'||typeof y==='string'||Array.isArray(l)||Array.isArray(y))return show(l)+show(y);return num1(N(l)+N(y));
      case '-':return num1(N(l)-N(y));case '*':return num1(N(l)*N(y));
      case '/':return N(y)===0?null:num1(N(l)/N(y));case '%':return N(y)===0?null:num1(N(l)%N(y));
      case '==':return l==y;case '!=':return l!=y;case '===':return l===y;case '!==':return l!==y;
      case '<':return l<y;case '>':return l>y;case '<=':return l<=y;case '>=':return l>=y}}}
  return null}
var CACHE=new Map();
function expr(src,L){var a=CACHE.get(src);if(!a){a=parse(src);if(CACHE.size>500)CACHE.clear();CACHE.set(src,a)}return ev(a,L)}
function isEx(v){return typeof v==='string'&&v.charCodeAt(0)===61}
function val(v,L){if(!isEx(v))return v;var s=v.slice(1).trim();
  if(s[0]==='{'&&s[s.length-1]==='}'){try{return expr(s.slice(1,-1),L)}catch(e){}}
  return expr(s,L)}
function interp(s,L){if(s.indexOf('{')<0)return s;var o='',i=0;
  while(i<s.length){var j=s.indexOf('{',i);if(j<0){o+=s.slice(i);break}o+=s.slice(i,j);
    var d=0,k=j,q='';
    for(;k<s.length;k++){var c=s[k];if(q){if(c===q)q=''}else if(c==='"'||c==="'")q=c;else if(c==='{')d++;else if(c==='}'&&--d===0)break}
    if(k>=s.length){o+=s.slice(j);break}
    var inner=s.slice(j+1,k);
    if(/[$(]/.test(inner)){try{o+=show(expr(inner,L))}catch(e){o+='{'+inner+'}'}}else o+=s.slice(j,k+1);
    i=k+1}
  return o}
function tx(v,L){if(isEx(v))return show(val(v,L));return typeof v==='string'?interp(v,L):show(v)}

/* ---------- function library (pure; bad arguments evaluate to null) ---------- */
function nums(a){var r=[];a.forEach(function(x){if(Array.isArray(x))r=r.concat(nums(x));else if(x!=null&&x!==''){var n=N(x);if(!isNaN(n))r.push(n)}});return r}
function fnx(f){var s=String(f);
  if(NAME.test(s.split('.')[0])&&/^[\w.]+$/.test(s)&&s!=='it'&&s!=='i')return function(x){return get(x,s)};
  var a=parse(isEx(s)?s.slice(1):s);return function(x,i){return ev(a,{it:x,i:i})}}
function dt(v){if(v instanceof Date)return v;if(typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v))return new Date(v+'T00:00:00');var d=new Date(v==null||v===''?NaN:v);return isNaN(d.getTime())?null:d}
function iso(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
function sumOf(a){return a.reduce(function(x,y){return x+y},0)}
var F={
  sum:function(){return sumOf(nums([].slice.call(arguments)))},
  avg:function(){var n=nums([].slice.call(arguments));return n.length?sumOf(n)/n.length:null},
  min:function(){var n=nums([].slice.call(arguments));return n.length?Math.min.apply(null,n):null},
  max:function(){var n=nums([].slice.call(arguments));return n.length?Math.max.apply(null,n):null},
  round:function(x,d){var m=Math.pow(10,d||0);return Math.round(N(x)*m)/m},
  fixed:function(x,d){return N(x).toFixed(d==null?2:d)},
  format:function(x,k,o){x=N(x);
    if(k==='currency')return x.toLocaleString(undefined,{style:'currency',currency:o||'USD'});
    if(k==='percent')return (x*100).toLocaleString(undefined,{maximumFractionDigits:o==null?1:o})+'%';
    if(k==='compact')return x.toLocaleString(undefined,{notation:'compact'});
    return x.toLocaleString(undefined,{maximumFractionDigits:o==null?2:o})},
  len:function(a){return typeof a==='string'||Array.isArray(a)?a.length:a&&typeof a==='object'?Object.keys(a).length:0},
  join:function(a,s){return arr(a).map(show).join(s==null?', ':s)},
  map:function(a,f){var g=fnx(f);return arr(a).map(function(x,i){return g(x,i)})},
  filter:function(a,f,v){if(arguments.length>2)return arr(a).filter(function(x){return get(x,f)==v});var g=fnx(f);return arr(a).filter(function(x,i){return g(x,i)})},
  sort:function(a,f,d){var g=f==null?function(x){return x}:fnx(f);
    return arr(a).slice().sort(function(x,y){var p=g(x),q=g(y),r=typeof p==='number'&&typeof q==='number'?p-q:String(p==null?'':p).localeCompare(String(q==null?'':q),undefined,{numeric:true});return d===true||d==='desc'?-r:r})},
  range:function(a,b,s){if(b==null){b=a;a=0}s=N(s)||1;var r=[];for(var i=N(a);(s>0?i<N(b):i>N(b))&&r.length<5000;i+=s)r.push(i);return r},
  'if':function(c,a,b){return c?a:b},
  concat:function(){var a=[].slice.call(arguments);return a.some(Array.isArray)?[].concat.apply([],a):a.map(show).join('')},
  upper:function(s){return show(s).toUpperCase()},lower:function(s){return show(s).toLowerCase()},
  clamp:function(x,a,b){return Math.min(N(b),Math.max(N(a),N(x)))},
  abs:function(x){return Math.abs(N(x))},floor:function(x){return Math.floor(N(x))},ceil:function(x){return Math.ceil(N(x))},
  pow:function(a,b){return Math.pow(N(a),N(b))},sqrt:function(x){return Math.sqrt(N(x))},
  num:function(x){return N(x)},str:function(x){return show(x)},
  pmt:function(rate,n,pv){var r=N(rate);n=N(n);pv=N(pv);return r===0?pv/n:pv*r/(1-Math.pow(1+r,-n))},
  contains:function(h,n){return typeof h==='string'?h.indexOf(show(n))>=0:arr(h).some(function(x){return x==n})},
  slice:function(a,s,e){return typeof a==='string'?a.slice(s,e):arr(a).slice(s,e)},
  unique:function(a){var seen=[];arr(a).forEach(function(x){if(seen.indexOf(x)<0)seen.push(x)});return seen},
  date:function(v,f){var d=dt(v);if(!d)return null;
    if(f==='iso')return iso(d);
    if(f==='time')return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    if(f==='long')return d.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    if(f==='month')return d.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})},
  today:function(){return iso(new Date())},
  addDays:function(v,n){var d=dt(v);if(!d)return null;d.setDate(d.getDate()+N(n));return iso(d)},
  daysBetween:function(a,b){var x=dt(a),y=dt(b);return x&&y?Math.round((y-x)/864e5):null}
};

/* ---------- state, effects, actions ---------- */
function put(k,v){k=String(k).replace(/^\$/,'');if(NAME.test(k)&&!BAD[k])S[k]=v}
function dflt(b,v){if(!own(S,b)){S[b]=v;INIT[b]=clone(v)}}
function set(b,v){S[b]=v;update()}
function run1(f){try{f()}catch(e){errs.push(String(e&&e.message||e))}}
function fx(f){FX.push(f);run1(f)}
function flush(){if(ER){ER.hidden=!errs.length;ER.textContent=errs.length?'Spec problem: '+errs[0]:''}}
function update(){if(busy)return;busy=true;errs.length=0;try{FX.forEach(run1)}finally{busy=false}flush()}
function sval(v){return isEx(v)?val(v):typeof v==='string'&&v.indexOf('{$')>=0?interp(v):v}
function toast(m){if(!DOC.body)return;var t=el('div','lw-toast',DOC.body);t.textContent=m;setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t)},1500)}
function copy(s){var ok=false;
  try{var t=el('textarea','',DOC.body);t.value=s;t.style.position='fixed';t.style.opacity='0';t.select();ok=DOC.execCommand('copy');DOC.body.removeChild(t)}catch(e){}
  if(ok)return toast('Copied');
  try{navigator.clipboard.writeText(s).then(function(){toast('Copied')},function(){toast('Copy is blocked here')})}catch(e){toast('Copy is blocked here')}}
function act(a){arr(a).forEach(function(x){if(!x||typeof x!=='object')return;
  try{
    if(x.set&&typeof x.set==='object'){var o={},k;for(k in x.set)o[k]=sval(x.set[k]);for(k in o)put(k,o[k])}
    if(x.reset){(Array.isArray(x.reset)?x.reset:Object.keys(INIT)).forEach(function(k){k=String(k).replace(/^\$/,'');if(own(INIT,k))S[k]=clone(INIT[k])})}
    if(x.toggle){var t=String(x.toggle).replace(/^\$/,'');if(NAME.test(t)&&!BAD[t])S[t]=!S[t]}
    if(x.toAssistant!=null&&typeof window!=='undefined'&&typeof window.sendPrompt==='function')window.sendPrompt(tx(x.toAssistant));
    if(x.copy!=null)copy(tx(x.copy));
  }catch(e){errs.push(String(e.message||e))}});
  update()}

/* ---------- DOM helpers (textContent / setAttribute only) ---------- */
function el(tag,cls,par){var e=DOC.createElement(tag);if(cls)e.className=cls;if(par)par.appendChild(e);return e}
function sv(tag,at,par){var e=DOC.createElementNS('http://www.w3.org/2000/svg',tag);for(var k in at)e.setAttribute(k,String(at[k]));if(par)par.appendChild(e);return e}
function clear(e){while(e.firstChild)e.removeChild(e.firstChild)}
function dyn(e,v){fx(function(){e.textContent=tx(v)});return e}
function live(e,get2,draw){fx(function(){var d=get2(),k=JSON.stringify(d);if(k===e._k)return;e._k=k;clear(e);draw(d)})}
function gap(e,n,d){var g=n.gap==null?d:N(val(n.gap));e.style.gap=(isNum(g)?g:d)*4+'px'}
function kids(e,c){arr(c).forEach(function(x){e.appendChild(build(x))})}
function bn(n){var b=String(n.bind||'').replace(/^\$/,'');if(!NAME.test(b)||BAD[b])throw Error(n.t+' needs "bind":"$name"');return b}
function wrap(n){var w=el('label','lw-f');if(n.label!=null)dyn(el('span','lw-fl',w),n.label);return w}
function opts(n){return arr(val(n.options)).map(function(x){return x!==null&&typeof x==='object'?{l:show(x.label!=null?x.label:x.value),v:x.value!==undefined?x.value:x.label}:{l:show(x),v:x}})}
function idx(o,v){for(var i=0;i<o.length;i++)if(o[i].v===v||String(o[i].v)===String(v))return i;return -1}

/* ---------- components ---------- */
var R={};
R.Col=function(n){var e=el('div','lw-col');gap(e,n,3);kids(e,n.c);return e};
R.Row=function(n){var e=el('div','lw-row');gap(e,n,3);var j=n.justify;
  if(j)e.style.justifyContent=j==='between'?'space-between':j==='end'?'flex-end':j==='center'?'center':'flex-start';
  if(n.wrap===false)e.style.flexWrap='nowrap';kids(e,n.c);return e};
R.Grid=function(n){var e=el('div','lw-grid');gap(e,n,3);e.style.setProperty('--cols',String(Math.max(1,Math.min(6,N(val(n.cols))||2))));kids(e,n.c);return e};
R.Card=function(n){var e=el('div','lw-card lw-col');gap(e,n,3);if(n.title!=null)dyn(el('div','lw-ct',e),n.title);kids(e,n.c);return e};
R.Tabs=function(n){var e=el('div','lw-tabs'),bar=el('div','lw-tb',e),bs=[],ps=[];
  arr(n.items).forEach(function(it,i){var b=el('button','',bar);b.type='button';b.setAttribute('role','tab');dyn(b,it&&it.label);
    var p=el('div','lw-col',e);kids(p,it&&it.c);b.addEventListener('click',function(){sel(i)});bs.push(b);ps.push(p)});
  function sel(k){bs.forEach(function(b,i){b.className=i===k?'lw-on':'';b.setAttribute('aria-selected',String(i===k));ps[i].hidden=i!==k})}
  sel(0);return e};
R.Divider=function(){return el('hr','lw-hr')};
R.Title=function(n){return dyn(el('div','lw-title'),n.text)};
R.Text=function(n){return dyn(el('p','lw-text'),n.text!=null?n.text:n.c)};
R.Caption=function(n){return dyn(el('div','lw-cap'),n.text!=null?n.text:n.c)};
R.Badge=function(n){var e=el('span','lw-badge');var t=n.tone;if(t==='info'||t==='success'||t==='warning'||t==='danger')e.className+=' '+t;return dyn(e,n.text!=null?n.text:n.label)};
R.List=function(n){var e=el(n.ordered?'ol':'ul','lw-list');live(e,function(){return arr(val(n.items)).map(function(x){return tx(x)})},function(d){d.forEach(function(s){txt2(el('li','',e),s)})});return e};
function txt2(e,s){e.textContent=s;return e}
// Only http(s) links become anchors; the bridge asks the host to open them after the user confirms.
function lnk(p,h,t){h=String(h||'').trim();var ok=/^https?:\/\/[^\s]+$/i.test(h)&&h.length<=2000,e=el(ok?'a':'span','lw-lnk',p);if(ok){e.href=h;e.title=h}return txt2(e,t||h)}
R.Link=function(n){var e=el('span','');live(e,function(){return [show(val(n.href)),tx(n.text!=null?n.text:n.label)]},function(d){lnk(e,d[0],d[1])});return e};
function inl(p,s){var re=/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|` + "`" + String.raw`[^` + "`" + String.raw`]+` + "`" + String.raw`|\[[^\]]+\]\([^)]*\))/g,i=0,m;
  while(m=re.exec(s)){if(m.index>i)p.appendChild(DOC.createTextNode(s.slice(i,m.index)));var t=m[0];
    if(t[0]==='` + "`" + String.raw`')txt2(el('code','',p),t.slice(1,-1));
    else if(t.slice(0,2)==='**')txt2(el('strong','',p),t.slice(2,-2));
    else if(t[0]==='*')txt2(el('em','',p),t.slice(1,-1));
    else{var lm=/^\[([^\]]+)\]\(([^)]*)\)/.exec(t);lnk(p,lm[2],lm[1])}
    i=m.index+t.length}
  if(i<s.length)p.appendChild(DOC.createTextNode(s.slice(i)))}
function md(e,s){var ls=String(s).split('\n'),cur=null,para=[];
  function fp(){if(para.length){inl(el('p','',e),para.join(' '));para=[]}}
  ls.forEach(function(ln){var m;
    if(m=/^\s*[-*]\s+(.*)$/.exec(ln)){fp();if(!cur||cur.tagName!=='UL')cur=el('ul','',e);inl(el('li','',cur),m[1])}
    else if(m=/^\s*\d+[.)]\s+(.*)$/.exec(ln)){fp();if(!cur||cur.tagName!=='OL')cur=el('ol','',e);inl(el('li','',cur),m[1])}
    else if(m=/^#{1,3}\s+(.*)$/.exec(ln)){fp();cur=null;inl(el('div','lw-h',e),m[1])}
    else if(!ln.trim()){fp();cur=null}
    else{cur=null;para.push(ln.trim())}});
  fp()}
R.Markdown=function(n){var e=el('div','lw-md');live(e,function(){return tx(n.text!=null?n.text:n.c)},function(s){md(e,s)});return e};
R.Code=function(n){var e=el('pre','lw-code');e.textContent=show(val(n.text!=null?n.text:n.code));return e};
R.Table=function(n){var e=el('div','lw-tw'),sk=-1,sd=1;
  live(e,function(){return [val(n.columns),val(n.rows),sk,sd]},function(d){
    var cols=arr(d[0]).map(function(c){return c&&typeof c==='object'?{k:c.key!=null?c.key:c.label,l:show(c.label!=null?c.label:c.key)}:{k:c,l:show(c)}});
    var cell=function(r,i){return Array.isArray(r)?r[i]:get(r,cols[i].k)};
    var rows=arr(d[1]).slice(0,1000);
    if(sk>=0)rows.sort(function(a,b){var p=cell(a,sk),q=cell(b,sk);return sd*(isNum(p)&&isNum(q)?p-q:show(p).localeCompare(show(q),undefined,{numeric:true}))});
    var t=el('table','lw-t',e),hr=el('tr','',el('thead','',t));
    cols.forEach(function(c,i){var th=el('th','',hr);th.textContent=c.l+(sk===i?(sd>0?' \u25B2':' \u25BC'):'');
      if(n.sortable!==false){th.className='lw-s';th.addEventListener('click',function(){if(sk===i)sd=-sd;else{sk=i;sd=1}update()})}});
    var tb=el('tbody','',t);
    rows.forEach(function(r){var tr=el('tr','',tb);cols.forEach(function(c,i){var v=cell(r,i),td=el('td',isNum(v)?'lw-n':'',tr);td.textContent=show(v)})})});
  return e};
var PAL=['#378ADD','#1D9E75','#D85A30','#7F77DD','#D4537E','#BA7517','#639922','#E24B4A'];
function nice(lo,hi){if(hi<=lo)hi=lo+1;var r=hi-lo,st=Math.pow(10,Math.floor(Math.log(r/4)/Math.LN10)),m=r/4/st;st*=m>5?10:m>2?5:m>1?2:1;return{lo:Math.floor(lo/st+1e-9)*st,hi:Math.ceil(hi/st-1e-9)*st,st:st}}
function legend(e,items){var g=el('div','lw-leg',e);items.forEach(function(it,i){var s=el('span','',g);var sw=el('span','lw-sw',s);sw.style.background=PAL[i%8];s.appendChild(DOC.createTextNode(it))})}
R.Chart=function(n){var e=el('div','lw-chart');
  live(e,function(){return [val(n.data),val(n.x),val(n.y),n.kind||n.type||'bar']},function(d){
    var kind=String(d[3]),rows=arr(d[0]).filter(function(r){return r&&typeof r==='object'}).slice(0,500),x=d[1],ys=arr(d[2]);
    if(rows.length){var ks=Object.keys(rows[0]);if(x==null)x=ks[0];if(!ys.length)ys=ks.filter(function(k){return k!==x&&isNum(N(rows[0][k]))&&rows[0][k]!==''&&rows[0][k]!==null})}
    if(!rows.length||!ys.length){el('div','lw-cap',e).textContent='No chart data';return}
    var xl=function(r){return show(get(r,x))};
    if(kind==='pie'||kind==='donut'){
      var vs=rows.map(function(r){return Math.max(0,N(get(r,ys[0]))||0)}),tot=sumOf(vs)||1,s=sv('svg',{viewBox:'0 0 200 200',role:'img'},e),a=-Math.PI/2,R0=90,r0=kind==='donut'?52:0;
      s.style.maxWidth='240px';
      vs.forEach(function(v,i){var f=Math.min(v/tot,0.99999),b=a+f*2*Math.PI,lg=f>0.5?1:0,c=Math.cos,sn=Math.sin;
        var dd='M'+(100+R0*c(a))+' '+(100+R0*sn(a))+'A'+R0+' '+R0+' 0 '+lg+' 1 '+(100+R0*c(b))+' '+(100+R0*sn(b))+'L'+(100+r0*c(b))+' '+(100+r0*sn(b))+(r0?'A'+r0+' '+r0+' 0 '+lg+' 0 '+(100+r0*c(a))+' '+(100+r0*sn(a)):'')+'Z';
        var p=sv('path',{d:dd,fill:PAL[i%8],stroke:'var(--color-background-primary)','stroke-width':1},s);sv('title',{},p).textContent=xl(rows[i])+': '+show(vs[i]);a=b});
      legend(e,rows.map(function(r,i){return xl(r)+': '+show(vs[i])+' ('+Math.round(vs[i]/tot*100)+'%)'}));return}
    var W=560,H=280,PL=50,PR=14,PT=12,PB=34,sc=kind==='scatter',all=[];
    ys.forEach(function(y){rows.forEach(function(r){var v=N(get(r,y));if(isNum(v))all.push(v)})});
    var ns=nice(sc?Math.min.apply(null,all):Math.min(0,Math.min.apply(null,all)),Math.max.apply(null,all));
    var yy=function(v){return PT+(H-PT-PB)*(1-(v-ns.lo)/(ns.hi-ns.lo))};
    var s2=sv('svg',{viewBox:'0 0 '+W+' '+H,role:'img'},e),cnt=rows.length,band=(W-PL-PR)/cnt,cx=function(i){return PL+band*(i+0.5)},xs=null;
    if(sc){var xv=rows.map(function(r){return N(get(r,x))});xs=nice(Math.min.apply(null,xv),Math.max.apply(null,xv));cx=function(i){return PL+(W-PL-PR)*(xv[i]-xs.lo)/(xs.hi-xs.lo)}}
    for(var t=ns.lo,g=0;t<=ns.hi+ns.st/2&&g<14;t+=ns.st,g++){sv('line',{x1:PL,x2:W-PR,y1:yy(t),y2:yy(t),'class':'lw-gl'},s2);var tl=sv('text',{x:PL-6,y:yy(t)+4,'text-anchor':'end','class':'ts'},s2);tl.textContent=show(parseFloat(t.toPrecision(6)))}
    if(sc){for(var u=xs.lo,h=0;u<=xs.hi+xs.st/2&&h<14;u+=xs.st,h++){var ul=sv('text',{x:PL+(W-PL-PR)*(u-xs.lo)/(xs.hi-xs.lo),y:H-PB+16,'text-anchor':'middle','class':'ts'},s2);ul.textContent=show(parseFloat(u.toPrecision(6)))}}
    else{var every=Math.ceil(cnt/12);rows.forEach(function(r,i){if(i%every)return;var l=xl(r),tt=sv('text',{x:cx(i),y:H-PB+16,'text-anchor':'middle','class':'ts'},s2);tt.textContent=l.length>10?l.slice(0,9)+'\u2026':l})}
    var base=yy(Math.max(ns.lo,0));
    ys.forEach(function(y,si){var col=PAL[si%8],pts=rows.map(function(r,i){return [cx(i),yy(N(get(r,y)))]});
      if(kind==='line'||kind==='area'){
        var pl=pts.map(function(p){return p[0]+','+p[1]}).join(' ');
        if(kind==='area')sv('polygon',{points:pts[0][0]+','+base+' '+pl+' '+pts[cnt-1][0]+','+base,fill:col,'fill-opacity':0.18},s2);
        sv('polyline',{points:pl,fill:'none',stroke:col,'stroke-width':2,'stroke-linejoin':'round'},s2)}
      rows.forEach(function(r,i){var v=N(get(r,y)),p=pts[i],tip;
        if(kind==='bar'){var bw=Math.min(40,band*0.8/ys.length),bx=cx(i)-bw*ys.length/2+bw*si;tip=sv('rect',{x:bx,y:Math.min(yy(v),base),width:bw,height:Math.abs(base-yy(v)),fill:col,rx:2},s2)}
        else if(sc||cnt<=40)tip=sv('circle',{cx:p[0],cy:p[1],r:sc?4:3,fill:col,'fill-opacity':sc?0.75:1},s2);
        if(tip)sv('title',{},tip).textContent=y+' '+xl(r)+': '+show(v)})});
    if(ys.length>1)legend(e,ys.map(String))});
  return e};
R.Stat=function(n){var e=el('div','lw-stat');dyn(el('div','lw-cap',e),n.label);dyn(el('div','lw-big',e),n.value);
  if(n.delta!=null){var d=el('div','lw-up',e);fx(function(){var s=tx(n.delta);d.textContent=s;d.className=/^\s*-/.test(s)?'lw-dn':'lw-up'})}return e};
R.Progress=function(n){var e=el('div','lw-col'),b=el('div','lw-bar',e),f=el('div','',b);e.style.gap='4px';b.setAttribute('role','progressbar');
  if(n.label!=null)dyn(el('div','lw-cap',e),n.label);
  fx(function(){var m=N(val(n.max))||100,v=Math.max(0,Math.min(m,N(val(n.value))));f.style.width=(v/m*100)+'%';b.setAttribute('aria-valuenow',String(v))});return e};
R.Input=function(n){var b=bn(n),w=wrap(n),nm=n.type==='number',i=el('input','',w);
  i.type=nm?'number':n.type==='email'||n.type==='search'?n.type:'text';
  if(n.placeholder!=null)i.placeholder=tx(n.placeholder);
  ['min','max','step'].forEach(function(k){if(n[k]!=null)i.setAttribute(k,String(N(val(n[k]))))});
  dflt(b,nm?0:'');
  i.addEventListener('input',function(){set(b,nm?(i.value===''?'':N(i.value)):i.value)});
  fx(function(){if(DOC.activeElement!==i)i.value=show(S[b])});return w};
R.TextArea=function(n){var b=bn(n),w=wrap(n),i=el('textarea','',w);if(n.rows)i.rows=N(val(n.rows))||3;if(n.placeholder!=null)i.placeholder=tx(n.placeholder);
  dflt(b,'');i.addEventListener('input',function(){set(b,i.value)});fx(function(){if(DOC.activeElement!==i)i.value=show(S[b])});return w};
R.Select=function(n){var b=bn(n),w=wrap(n),s=el('select','',w),o=opts(n);
  o.forEach(function(x,i){var p=el('option','',s);p.value=String(i);p.textContent=x.l});
  dflt(b,o.length?o[0].v:null);
  s.addEventListener('change',function(){var x=o[N(s.value)];if(x)set(b,x.v)});
  fx(function(){var k=idx(o,S[b]);if(k>=0)s.value=String(k)});return w};
function choice(n,seg){var b=bn(n),o=opts(n),w=el('div','lw-f'),nm='r'+(++uid),its=[];
  if(n.label!=null)dyn(el('span','lw-fl',w),n.label);
  var g=el('div',seg?'lw-seg':'lw-radio',w);g.setAttribute('role',seg?'group':'radiogroup');dflt(b,o.length?o[0].v:null);
  o.forEach(function(x){var it;
    if(seg){it=el('button','',g);it.type='button';it.textContent=x.l;it.addEventListener('click',function(){set(b,x.v)})}
    else{var l=el('label','lw-rl',g);it=el('input','',l);it.type='radio';it.name=nm;el('span','',l).textContent=x.l;it.addEventListener('change',function(){if(it.checked)set(b,x.v)})}
    its.push(it)});
  fx(function(){var k=idx(o,S[b]);its.forEach(function(it,i){if(seg){it.className=i===k?'lw-on':'';it.setAttribute('aria-pressed',String(i===k))}else it.checked=i===k})});return w}
R.RadioGroup=function(n){return choice(n,false)};
R.SegmentedControl=function(n){return choice(n,true)};
R.Slider=function(n){var b=bn(n),w=wrap(n),mn=N(val(n.min)),mx=n.max==null?100:N(val(n.max)),i=el('input','',w),r=el('span','lw-val');
  i.type='range';i.min=String(mn);i.max=String(mx);i.step=String(n.step==null?1:N(val(n.step)));dflt(b,mn);
  var fl=w.firstChild;if(fl&&fl.className==='lw-fl')fl.appendChild(r);else w.insertBefore(r,i);
  i.addEventListener('input',function(){set(b,N(i.value))});
  fx(function(){i.value=String(S[b]);r.textContent=show(S[b])+(n.unit?' '+n.unit:'')});return w};
R.Checkbox=function(n){var b=bn(n),w=el('label','lw-ck'),i=el('input','',w);i.type='checkbox';dyn(el('span','',w),n.label);dflt(b,false);
  i.addEventListener('change',function(){set(b,i.checked)});fx(function(){i.checked=!!S[b]});return w};
R.DatePicker=function(n){var b=bn(n),w=wrap(n),i=el('input','',w);i.type='date';dflt(b,'');
  i.addEventListener('input',function(){set(b,i.value)});fx(function(){if(DOC.activeElement!==i)i.value=show(S[b])});return w};
R.Button=function(n){var e=el('button','lw-btn'+(n.variant==='primary'?' lw-pri':''));e.type='button';dyn(e,n.label);e.addEventListener('click',function(){act(n.action)});return e};
R.Form=function(n){var f=el('form','lw-col');gap(f,n,3);kids(f,n.c);
  if(n.submit!=null){var b=el('button','lw-pri',f);b.type='submit';dyn(b,n.submit)}
  f.addEventListener('submit',function(ev){ev.preventDefault();act(n.action)});return f};
R.Flashcard=function(n){var e=el('button','lw-fc'),back=false;e.type='button';
  function draw(){e.textContent=tx(back?n.back:n.front);e.setAttribute('aria-label',back?'Answer, press to flip':'Question, press to flip')}
  e.addEventListener('click',function(){back=!back;draw()});fx(draw);return e};
R.Timer=function(n){var tot=Math.max(1,N(val(n.seconds))||60),left=tot,id=0,t0=0,b0=0,e=el('div','lw-timer'),d=el('span','lw-big',e),go=el('button','',e),rs=el('button','',e);
  go.type=rs.type='button';rs.textContent='Reset';go.textContent='Start';
  function draw(){var s=Math.max(0,Math.ceil(left));d.textContent=left<=0?'Done':p2(Math.floor(s/60))+':'+p2(s%60)}
  function stop(){if(id){clearInterval(id);id=0}}
  function tick(){left=b0-(Date.now()-t0)/1000;if(left<=0){left=0;stop();go.textContent='Start'}draw()}
  go.addEventListener('click',function(){if(id){stop();go.textContent='Resume'}else{if(left<=0)left=tot;b0=left;t0=Date.now();id=setInterval(tick,200);go.textContent='Pause'}});
  rs.addEventListener('click',function(){stop();left=tot;go.textContent='Start';draw()});draw();return e};
var SA={x:'x',y:'y',w:'width',h:'height',cx:'cx',cy:'cy',r:'r',rx:'rx',x1:'x1',y1:'y1',x2:'x2',y2:'y2',d:'d',fill:'fill',stroke:'stroke',sw:'stroke-width',size:'font-size',anchor:'text-anchor',opacity:'opacity'};
var CLR=/^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|var\(--[\w-]+\))$/i,PD=/^[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+-]*$/;
var RS={Rect:'rect',Circle:'circle',Line:'line',Path:'path',Text:'text'};
function bs(n){var tag=RS[n&&n.t];if(!tag)throw Error('Svg children must be Rect, Circle, Line, Path or Text');
  var e=sv(tag,{});
  if(tag==='line'||tag==='path'){e.setAttribute('stroke','currentColor');e.setAttribute('fill','none')}else e.setAttribute('fill','currentColor');
  Object.keys(SA).forEach(function(k){if(n[k]==null)return;
    fx(function(){var v=val(n[k]),a=SA[k];
      if(k==='fill'||k==='stroke'){if(typeof v==='string'&&CLR.test(v))e.setAttribute(a,v)}
      else if(k==='d'){if(typeof v==='string'&&PD.test(v))e.setAttribute(a,v)}
      else if(k==='anchor'){if(v==='start'||v==='middle'||v==='end')e.setAttribute(a,v)}
      else if(isNum(N(v)))e.setAttribute(a,String(N(v)))})});
  if(typeof n.cls==='string'&&/^[\w -]+$/.test(n.cls))e.setAttribute('class',n.cls);
  if(tag==='text')dyn(e,n.text);return e}
R.Svg=function(n){var w=N(val(n.w))||300,h=N(val(n.h))||150,s=sv('svg',{viewBox:'0 0 '+w+' '+h,role:'img','class':'lw-svg'});
  s.style.width='100%';s.style.maxWidth=w+'px';arr(n.c).forEach(function(x){s.appendChild(bs(x))});return s};

function build(n){
  if(n==null||typeof n!=='object')return dyn(el('p','lw-text'),n);
  if(!own(R,n.t)){var w=el('div','lw-err');w.textContent='Unknown component: '+show(n.t);return w}
  if(++depth>40){depth--;throw Error('spec nested too deeply')}
  var e;try{e=R[n.t](n)}finally{depth--}
  if(n.show!=null)fx(function(){e.hidden=!val(n.show)});
  return e}

function mount(spec,state,root,doc){
  DOC=doc||document;S={};INIT={};FX=[];errs.length=0;busy=false;
  if(state&&typeof state==='object')Object.keys(state).forEach(function(k){put(k,state[k]);var nm=k.replace(/^\$/,'');if(own(S,nm))INIT[nm]=clone(S[nm])});
  ER=el('div','lw-err',root);ER.hidden=true;
  try{if(spec==null||typeof spec!=='object'||Array.isArray(spec))spec={t:'Col',c:spec};root.appendChild(build(spec))}catch(e){errs.push(String(e&&e.message||e))}
  flush();return S}
function evaluate(src,vars){var old=S;S=vars||{};try{return expr(src,{})}finally{S=old}}
return {mount:mount,evaluate:evaluate,parse:parse,show:show,functions:F,state:function(){return S}};
})();
`;
