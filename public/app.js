(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  const form = $('#form');
  const fileInput = $('#file');
  const drop = $('#drop');
  const dropTitle = $('#drop-title');
  const dropHint = $('#drop-hint');
  const submit = $('#submit');
  const formError = $('#form-error');
  const resultBody = $('#result-body');
  const servicesList = $('#services');
  const filter = $('#lang-filter');
  const counter = $('#lang-count');
  const estimateEl = $('#estimate');
  const saveForm = $('#save-project');
  const saveNameInput = $('#project-name');
  const saveHint = $('#save-project-hint');
  const saveError = $('#save-project-error');
  const langs = [...document.querySelectorAll('.lang')];
  const checkboxes = langs.map((label) => label.querySelector('input'));

  const MAX_KB = Number(drop.dataset.maxKb) || 512;
  const ALLOWED = /\.(json|js|cjs|mjs)$/i;
  const STORAGE_KEY = 'file-translator:prefs';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Petit utilitaire de création de DOM (tout passe par textContent : pas d'injection HTML).
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null) node.append(child);
    return node;
  }

  function formatSize(bytes) {
    return bytes < 1024 ? `${bytes} o` : `${(bytes / 1024).toFixed(1).replace('.', ',')} Ko`;
  }

  /* ---------- Fichier ---------- */

  function showFormError(message) {
    formError.textContent = message || '';
    formError.hidden = !message;
  }

  function refreshDrop() {
    const file = fileInput.files[0];
    drop.classList.toggle('has-file', Boolean(file));
    if (file) {
      dropTitle.textContent = file.name;
      dropHint.textContent = `${formatSize(file.size)}. Cliquez ou déposez un autre fichier pour le remplacer.`;
    } else {
      dropTitle.textContent = 'Déposez un fichier .json ou .js ici';
      dropHint.textContent = `ou cliquez pour le choisir. ${MAX_KB} Ko maximum.`;
    }
  }

  function setFile(file) {
    if (!ALLOWED.test(file.name)) {
      showFormError('Format non pris en charge. Choisissez un fichier .json ou .js.');
      return;
    }
    if (file.size > MAX_KB * 1024) {
      showFormError(`Ce fichier est trop volumineux (${MAX_KB} Ko maximum).`);
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    showFormError('');
    refreshDrop();
    updateEstimate();
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) setFile(file);
    else refreshDrop();
    updateEstimate();
  });

  // Un fichier lâché à côté de la zone ne doit pas faire quitter la page.
  for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  /* ---------- Langues ---------- */

  function updateCount() {
    const n = checkboxes.filter((c) => c.checked).length;
    counter.textContent = `${n} ${n > 1 ? 'langues choisies' : 'langue choisie'}`;
  }

  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const label of langs) label.hidden = query !== '' && !label.dataset.search.includes(query);
  });

  $('#select-visible').addEventListener('click', () => {
    langs.forEach((label, i) => { if (!label.hidden) checkboxes[i].checked = true; });
    updateCount();
    savePrefs();
    updateEstimate();
  });

  $('#clear-all').addEventListener('click', () => {
    checkboxes.forEach((c) => { c.checked = false; });
    updateCount();
    savePrefs();
    updateEstimate();
  });

  checkboxes.forEach((c) => c.addEventListener('change', () => { updateCount(); savePrefs(); updateEstimate(); }));

  // On retient les langues et la langue source d'une visite à l'autre.
  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        targets: checkboxes.filter((c) => c.checked).map((c) => c.value),
        source: form.elements.source.value,
      }));
    } catch { /* stockage indisponible */ }
  }

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!prefs) return;
      for (const c of checkboxes) c.checked = prefs.targets?.includes(c.value) ?? false;
      if (prefs.source) form.elements.source.value = prefs.source;
    } catch { /* préférences illisibles */ }
    updateCount();
  }

  form.elements.source.addEventListener('change', savePrefs);

  /* ---------- Estimation du temps ---------- */

  let lastCountedKey = null;
  let estimatedCount = null;
  let providersState = [];
  let estimateTimer = null;

  async function refreshCount() {
    const file = fileInput.files[0];
    if (!file) { estimatedCount = null; lastCountedKey = null; return; }
    const key = `${file.name}:${file.size}:${form.elements.ignoreKeys.value}`;
    if (key === lastCountedKey) return;
    lastCountedKey = key;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('ignoreKeys', form.elements.ignoreKeys.value);
      const res = await fetch('/api/estimate', { method: 'POST', body: fd });
      const data = await res.json();
      estimatedCount = res.ok ? data.count : null;
    } catch {
      estimatedCount = null;
    }
  }

  function formatDuration(seconds) {
    if (seconds < 45) return 'quelques secondes';
    if (seconds < 90) return 'environ une minute';
    return `environ ${Math.round(seconds / 60)} minutes`;
  }

  async function updateEstimateNow() {
    await refreshCount();
    const targetsCount = checkboxes.filter((c) => c.checked).length;
    if (!estimatedCount || targetsCount === 0) { estimateEl.hidden = true; return; }

    const total = estimatedCount * targetsCount;
    const apiReady = providersState.some((p) => ['deepl', 'google'].includes(p.name) && p.state === 'ready');
    const puppeteerReady = providersState.some((p) => p.name === 'puppeteer' && p.state === 'ready');

    if (apiReady) {
      estimateEl.textContent = `Estimation : ${formatDuration(Math.max(2, total * 0.05))} (via l'API).`;
    } else if (puppeteerReady) {
      estimateEl.textContent =
        `Estimation : ${formatDuration(total * 3)} ` +
        `(jusqu'à ${formatDuration(total * 15)} en cas de ralentissement — traduction via navigateur, plus lente).`;
    } else {
      estimateEl.textContent = 'Aucun service de traduction disponible actuellement.';
    }
    estimateEl.hidden = false;
  }

  function updateEstimate() {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(updateEstimateNow, 300);
  }

  form.elements.ignoreKeys.addEventListener('input', updateEstimate);

  /* ---------- Résultat ---------- */

  let currentJobId = null;

  function showEmpty() {
    currentJobId = null;
    saveForm.hidden = true;
    saveHint.hidden = true;
    saveError.hidden = true;
    resultBody.replaceChildren(
      h('h2', { text: 'Résultat' }),
      h('p', {
        class: 'muted',
        text: 'Choisissez un fichier et au moins une langue, puis lancez la traduction. Les fichiers traduits apparaissent ici, un par langue.',
      }),
    );
  }

  function showProgress(job) {
    saveForm.hidden = true;
    saveHint.hidden = true;
    const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
    let bar = $('#bar');
    if (!bar) {
      resultBody.replaceChildren(
        h('h2', { text: 'Traduction en cours' }),
        h('div', { class: 'bar', id: 'bar', role: 'progressbar', 'aria-label': 'Progression', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span')),
        h('p', { class: 'muted', id: 'bar-text' }),
      );
      bar = $('#bar');
    }
    bar.setAttribute('aria-valuenow', percent);
    bar.firstElementChild.style.width = `${percent}%`;
    $('#bar-text').textContent = `${job.done} sur ${job.total} textes traduits`;
  }

  function showDone(job) {
    const failed = job.files.length === 0;
    const nodes = [h('h2', { text: failed ? 'La traduction a échoué' : 'Fichiers traduits' })];

    if (job.errors.length) {
      nodes.push(h('ul', { class: 'issues' }, job.errors.map((e) =>
        h('li', { text: e.label ? `${e.label} : ${e.message}` : e.message }))));
    }

    if (job.files.length) {
      nodes.push(h('ul', { class: 'files' }, job.files.map((file) =>
        h('li', { class: 'file' },
          h('div', { class: 'file-main' },
            h('span', { class: 'file-name', text: file.name }),
            h('span', { class: 'file-meta', text: `${file.label}, ${formatSize(file.size)}, ${file.providers.join(' + ') || 'cache'}` })),
          h('a', { class: 'btn btn-small', href: file.url, download: file.name, text: 'Télécharger' })))));
    }

    if (job.zipUrl) nodes.push(h('a', { class: 'btn', href: job.zipUrl, text: 'Tout télécharger (.zip)' }));

    if (job.warningsTotal) {
      const more = job.warningsTotal - job.warnings.length;
      nodes.push(h('details', { class: 'warnings' },
        h('summary', { text: `${job.warningsTotal} texte${job.warningsTotal > 1 ? 's' : ''} conservé${job.warningsTotal > 1 ? 's' : ''} tel${job.warningsTotal > 1 ? 's' : ''} quel${job.warningsTotal > 1 ? 's' : ''}` }),
        h('ul', {}, [
          ...job.warnings.map((w) => h('li', { text: `${w.lang ? `${w.lang}, ` : ''}${w.path} : ${w.message}` })),
          more > 0 ? h('li', { text: `… et ${more} autre${more > 1 ? 's' : ''}` }) : null,
        ])));
    }

    resultBody.replaceChildren(...nodes);

    if (job.canSaveAsProject) {
      saveForm.hidden = false;
      saveHint.hidden = false;
    } else {
      saveForm.hidden = true;
      saveHint.hidden = true;
    }
  }

  async function poll(id) {
    for (; ;) {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) throw new Error('Cette traduction a expiré. Relancez-la.');
      const job = await res.json();
      if (job.status !== 'running') return job;
      showProgress(job);
      await sleep(700);
    }
  }

  /* ---------- Envoi ---------- */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError('');

    if (!fileInput.files[0]) return showFormError('Choisissez un fichier à traduire.');
    if (!checkboxes.some((c) => c.checked)) return showFormError('Choisissez au moins une langue.');

    submit.disabled = true;
    submit.textContent = 'Traduction en cours…';
    resultBody.replaceChildren(h('h2', { text: 'Envoi du fichier' }), h('p', { class: 'muted', text: 'Analyse du fichier…' }));
    if (window.matchMedia('(max-width: 60rem)').matches) {
      $('#result').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }

    try {
      const res = await fetch('/api/jobs', { method: 'POST', body: new FormData(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

      currentJobId = data.id;
      showDone(await poll(data.id));
    } catch (err) {
      showEmpty();
      showFormError(err.message);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Traduire le fichier';
      loadServices();
    }
  });

  /* ---------- Services ---------- */

  saveForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentJobId) return;
    saveError.hidden = true;
    const name = saveNameInput.value.trim();
    if (!name) { saveNameInput.focus(); return; }

    const button = saveForm.querySelector('button');
    button.disabled = true;
    button.textContent = 'Enregistrement…';
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: currentJobId, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      window.location.href = `/projects/${data.id}`;
    } catch (err) {
      saveError.textContent = err.message;
      saveError.hidden = false;
      button.disabled = false;
      button.textContent = 'Enregistrer comme projet';
    }
  });

  const STATE_LABELS = { ready: 'Prêt', paused: 'En pause (quota ou clé)', off: 'Non configuré' };

  async function loadServices() {
    try {
      const list = await (await fetch('/api/providers')).json();
      providersState = list;
      servicesList.replaceChildren(...list.map((p) =>
        h('li', { class: `svc-${p.state}` },
          h('span', { text: p.label }),
          h('span', { class: 'svc-state', text: STATE_LABELS[p.state] || p.state }))));
      updateEstimate();
    } catch { /* non bloquant */ }
  }

  loadPrefs();
  refreshDrop();
  showEmpty();
  loadServices();
})();