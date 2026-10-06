const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

async function build() {
  const input = path.join(__dirname, '../renderer/styles/tailwind.css');
  const output = path.join(__dirname, '../renderer/styles/output.css');
  const css = await fs.readFile(input, 'utf8');
  const result = await postcss([tailwind()]).process(css, { from: input, to: output });
  await fs.writeFile(output, result.css);
  console.log(`Built ${output}`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

if (process.argv.includes('--watch')) {
  let timer;
  for (const directory of ['renderer/styles', 'renderer/scripts']) {
    watch(path.join(__dirname, '..', directory), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void build().catch(console.error), 200);
    });
  }
  watch(path.join(__dirname, '../renderer/index.html'), () => {
    clearTimeout(timer);
    timer = setTimeout(() => void build().catch(console.error), 200);
  });
}
