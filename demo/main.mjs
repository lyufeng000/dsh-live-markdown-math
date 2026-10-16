import { createLiveEditor } from '../src/editor.mjs';
import css from '../src/styles.css';
import katexCss from 'katex/dist/katex.min.css';
const style = document.createElement('style');
style.textContent = `${katexCss}\n${css}`; document.head.append(style);
const samples = {
  basic: '# 在输入时，看见结构\n\n这是一段 **加粗**、*斜体* 和 ~~删除线~~。\n\n> 光标离开当前行，Markdown 标记会淡出。\n\n- [x] 保留原始 Markdown\n- [ ] 点击公式编辑源码\n\n行内公式：$E=mc^2$。\n\n$$\nf(x)=\\int_0^x t^2\\,dt=\\frac{x^3}{3}\n$$\n\n`$这里不是公式$`\n',
  math: '# LaTeX 公式\n\n内联：\\(\\alpha^2 + \\beta^2 = 1\\)\n\n$$\n\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}\n$$\n\n\\[\\sum_{n=1}^{\\infty}\\frac{1}{n^2}=\\frac{\\pi^2}{6}\\]\n\n未完成的公式保留源码：$\\frac{$\n',
  security: '# 安全降级\n\nHTML 保留为文字，不执行：\n\n<img src="https://example.invalid/tracker" onerror="alert(1)">\n\n图片不发请求：![离线图片](https://example.invalid/image.png)\n\n危险 TeX 不启用：$\\href{javascript:alert(1)}{click}$\n\n```tex\n$x^2$ 不在代码块内渲染\n```\n',
};
const editor = createLiveEditor(document.querySelector('#editor'), {
  value: samples.basic,
  onChange(text) { document.querySelector('#source').textContent = text; },
  onSubmit(complement) {
    document.querySelector('#notice').textContent = complement ? '演示不执行快捷转向。正式插件须返回原生输入框。' : '仅演示：源码已复制到下方展示区，没有发送任何消息。';
    document.querySelector('#source').textContent = editor.value;
  },
  onFiles() { document.querySelector('#notice').textContent = '正式插件会返回原生输入框，并提示重新粘贴 / 拖入文件。演示不导入附件。'; },
});
document.querySelector('#source').textContent = editor.value;
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  const live = button.dataset.mode === 'live'; editor.setLive(live);
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
}));
document.querySelectorAll('[data-sample]').forEach(button => button.addEventListener('click', () => {
  editor.setValue(samples[button.dataset.sample]); document.querySelector('#source').textContent = editor.value;
}));
document.querySelector('#send').addEventListener('click', () => {
  document.querySelector('#notice').textContent = '演示发送：只展示原始文本，不访问 DSH 或网络。';
  document.querySelector('#source').textContent = editor.value;
});
