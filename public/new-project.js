(() => {
    'use strict';

    const $ = (selector) => document.querySelector(selector);

    const form = $('#form');
    const nameInput = $('#project-name');
    const fileInput = $('#file');
    const drop = $('#drop');
    const dropTitle = $('#drop-title');
    const dropHint = $('#drop-hint');
    const submit = $('#submit');
    const formError = $('#form-error');
    const resultBody = $('#result-body');
    const filter = $('#lang-filter');
    const counter = $('#lang-count');
    const langs = [...document.querySelectorAll('.lang')];
    const checkboxes = langs.map((label) => label.querySelector('input'));

    const MAX_KB = Number(drop.dataset.maxKb) || 512;
    const ALLOWED = /\.(json|js|cjs|mjs)$/i;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    function showFormError(message) {
        formError.textContent = message || '';
        formError.hidden = !message;
    }

    /* ---------- Fichier (glisser-déposer) ---------- */

    function refreshDrop() {
        const file = fileInput.files[0];
        drop.classList.toggle('has-file', Boolean(file));
        dropTitle.textContent = file ? file.name : 'Déposez un fichier .json ou .js ici';
        dropHint.textContent = file ? 'Cliquez ou déposez un autre fichier pour le remplacer.' : `ou cliquez pour le choisir. ${MAX_KB} Ko maximum.`;
    }

    function setFile(file) {
        if (!ALLOWED.test(file.name)) return showFormError('Format non pris en charge. Choisissez un fichier .json ou .js.');
        if (file.size > MAX_KB * 1024) return showFormError(`Ce fichier est trop volumineux (${MAX_KB} Ko maximum).`);
        const transfer = new DataTransfer();
        transfer.items.add(file);
        fileInput.files = transfer.files;
        showFormError('');
        refreshDrop();
    }

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) setFile(fileInput.files[0]);
        else refreshDrop();
    });

    for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
    for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
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
    });
    $('#clear-all').addEventListener('click', () => {
        checkboxes.forEach((c) => { c.checked = false; });
        updateCount();
    });
    checkboxes.forEach((c) => c.addEventListener('change', updateCount));

    /* ---------- Progression ---------- */

    function showProgress(job) {
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

        const name = nameInput.value.trim();
        if (!name) { showFormError('Donnez un nom au projet.'); nameInput.focus(); return; }
        if (!fileInput.files[0]) return showFormError('Choisissez un fichier à traduire.');
        if (!checkboxes.some((c) => c.checked)) return showFormError('Choisissez au moins une langue.');

        submit.disabled = true;
        submit.textContent = 'Création en cours…';
        resultBody.replaceChildren(h('h2', { text: 'Envoi du fichier' }), h('p', { class: 'muted', text: 'Analyse du fichier…' }));

        try {
            const fd = new FormData(form);
            fd.delete('name'); // ce champ ne concerne pas /api/jobs, seulement la création du projet ensuite
            const res = await fetch('/api/jobs', { method: 'POST', body: fd });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

            const job = await poll(data.id);
            if (job.files.length === 0) {
                const detail = job.errors[0]?.message;
                throw new Error(detail ? `La traduction a échoué : ${detail}` : 'La traduction a échoué, aucun fichier produit.');
            }

            resultBody.replaceChildren(h('h2', { text: 'Enregistrement du projet…' }));
            const createRes = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: data.id, name }),
            });
            const createData = await createRes.json().catch(() => ({}));
            if (!createRes.ok) throw new Error(createData.error || `Erreur ${createRes.status}`);

            window.location.href = `/projects/${createData.id}`;
        } catch (err) {
            resultBody.replaceChildren(h('h2', { text: 'Résultat' }), h('p', { class: 'muted', text: 'Le projet est créé une fois le fichier traduit dans toutes les langues choisies.' }));
            showFormError(err.message);
            submit.disabled = false;
            submit.textContent = 'Créer le projet';
        }
    });

    updateCount();
    refreshDrop();
})();