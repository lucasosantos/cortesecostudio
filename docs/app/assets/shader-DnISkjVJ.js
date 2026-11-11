import{n as e}from"./rolldown-runtime-Dd_uD5pT.js";import{a as t}from"./interp-C1S7X33e.js";var n=e({ANIM_PAD:()=>p,ENTRY_FUNCTION:()=>m,PARAM_GLSL:()=>r,PARAM_LABELS:()=>i,RESERVED:()=>a,VERTEX:()=>o,buildAnimationSource:()=>f,buildEffectSource:()=>u,buildSource:()=>h,buildTransitionSource:()=>d,defaultFor:()=>_,isParamName:()=>s,paramUniforms:()=>c,parseShaderLog:()=>g,uniformValue:()=>v}),r={float:`float`,int:`int`,bool:`bool`,color:`vec4`,color3:`vec3`,vec2:`vec2`,ivec2:`ivec2`},i={float:`Número`,int:`Inteiro`,bool:`Liga/desliga`,color:`Cor com transparência`,color3:`Cor`,vec2:`Par de números`,ivec2:`Par de inteiros`},a=new Set([`time`,`progress`,`resolution`,`ratio`,`uSrc`,`uFrom`,`uTo`,`vUv`,`outColor`,`getColor`,`getFromColor`,`getToColor`,`effect`,`transition`,`animate`,`entering`,`uBox`,`main`,`texture`,`texture2D`]),o=`#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`,s=e=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)&&!/^gl_/.test(e)&&!a.has(e);function c(e=[]){return e.filter(e=>r[e.type]&&s(e.name)).map(e=>`uniform ${r[e.type]} ${e.name};`).join(`
`)}var l=`#version 300 es
precision highp float;
precision highp int;
#define texture2D texture
in vec2 vUv;
out vec4 outColor;
uniform float time;
uniform float progress;
uniform vec2 resolution;
uniform float ratio;`;function u(e){return`${l}
uniform sampler2D uSrc;
${c(e.params)}
vec4 getColor(vec2 uv) {
  vec4 c = texture(uSrc, uv);
  return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
#line 1
${e.glsl}
void main() {
  vec4 c = clamp(effect(vUv), 0.0, 1.0);
  outColor = vec4(c.rgb * c.a, c.a);
}`}function d(e){return`${l}
uniform sampler2D uFrom;
uniform sampler2D uTo;
${c(e.params)}
vec4 getFromColor(vec2 uv) { return texture(uFrom, uv); }
vec4 getToColor(vec2 uv) { return texture(uTo, uv); }
#line 1
${e.glsl}
void main() {
  outColor = clamp(transition(vUv), 0.0, 1.0);
}`}function f(e){return`${l}
uniform sampler2D uSrc;
uniform bool entering;
uniform vec4 uBox;
${c(e.params)}
vec4 getColor(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = texture(uSrc, uv);
  return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
#line 1
${e.glsl}
void main() {
  vec4 c = clamp(animate((vUv - uBox.xy) / uBox.zw), 0.0, 1.0);
  outColor = vec4(c.rgb * c.a, c.a);
}`}var p=.25,m={effect:`effect`,transition:`transition`,animation:`animate`},h=e=>e.kind===`transition`?d(e):e.kind===`animation`?f(e):u(e);function g(e,t=1/0){let n=[];for(let r of String(e||``).split(`
`)){let e=r.trim();if(!e)continue;let i=/^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(e);i?n.push({line:Math.max(1,Math.min(Number(i[1]),t)),message:i[2]}):n.push({line:0,message:e})}return n}function _(e){let t=e.default;switch(e.type){case`bool`:return!!t;case`int`:return Number.isFinite(Number(t))?Math.round(Number(t)):0;case`color`:return typeof t==`string`&&t[0]===`#`?t:`#ffffffff`;case`color3`:return typeof t==`string`&&t[0]===`#`?t:`#ffffff`;case`vec2`:case`ivec2`:return Array.isArray(t)&&t.length===2&&t.every(e=>Number.isFinite(Number(e)))?t.map(Number):[0,0];default:return Number.isFinite(Number(t))?Number(t):0}}function v(e,n){switch(n??=_(e),e.type){case`bool`:return+!!n;case`int`:return Math.round(Number(n)||0);case`color`:return t(n).map(e=>e/255);case`color3`:return t(n).slice(0,3).map(e=>e/255);case`vec2`:return[Number(n?.[0])||0,Number(n?.[1])||0];case`ivec2`:return[Math.round(Number(n?.[0])||0),Math.round(Number(n?.[1])||0)];default:return Number(n)||0}}export{o as a,s as c,v as d,i,g as l,m as n,h as o,r,_ as s,p as t,n as u};