import { globalPages } from './luowang-v07-design-pages-global.js';
import { projectPages } from './luowang-v07-design-pages-project.js';

const pageRenderers = { ...globalPages, ...projectPages };
const defaultPage = 'workspace';

const app = document.querySelector('#app');
const pageSelect = document.querySelector('#page-select');
const dialog = document.querySelector('#confirm-dialog');
const modalTrigger = document.querySelector('#modal-trigger');

function pageFromHash() {
  const page = window.location.hash.replace(/^#\/?/, '');
  return pageRenderers[page] ? page : '';
}

let currentPage = pageFromHash() || localStorage.getItem('luowang-v07-design-page') || defaultPage;
if (!pageRenderers[currentPage]) currentPage = defaultPage;

function render() {
  app.innerHTML = pageRenderers[currentPage]();
  pageSelect.value = currentPage;
  document.title = `${pageSelect.selectedOptions[0]?.textContent || '罗网'} · v0.7.0 设计原型`;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function switchPage(page, options = {}) {
  if (!pageRenderers[page]) return;
  currentPage = page;
  localStorage.setItem('luowang-v07-design-page', page);
  if (!options.fromHash) window.history.pushState(null, '', `#/${page}`);
  render();
}

pageSelect.addEventListener('change', (event) => switchPage(event.target.value));
modalTrigger.addEventListener('click', () => dialog.showModal());

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-page], [data-open-modal]');
  if (!target || target.disabled) return;
  if (target.hasAttribute('data-open-modal')) {
    dialog.showModal();
    return;
  }
  switchPage(target.dataset.page);
});

dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close('cancel');
});

window.addEventListener('hashchange', () => {
  const page = pageFromHash();
  if (page && page !== currentPage) switchPage(page, { fromHash: true });
});

if (!pageFromHash()) window.history.replaceState(null, '', `#/${currentPage}`);
render();
