import katex from 'katex';
import fs from 'fs';
const files = process.argv.slice(2, -1), out = process.argv.at(-1);
let html = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
let n = 0, bad = [];
html = html.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
  try { n++; return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: true, strict: false }); }
  catch (e) { bad.push(tex.trim() + ' :: ' + e.message.split('\n')[0]); return m; }
});
html = html.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
  try { n++; return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: true, strict: false }); }
  catch (e) { bad.push(tex.trim() + ' :: ' + e.message.split('\n')[0]); return m; }
});
const css = fs.readFileSync('node_modules/katex/dist/katex.min.css', 'utf8');
html = html.replace('</style>', '</style>\n<style>' + css + '\n.katex{font-size:1.05em;}\n.katex-display{margin:.45em 0;}\n</style>');
fs.writeFileSync(out, html);
console.log('rendered', n, 'expressions; errors:', bad.length);
bad.slice(0, 20).forEach(b => console.log('  !', b));
