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

    const MAX_KB = Number(drop.dataset.maxKb) || 512;
    const ALLOWED = /\.(json|js|cjs|mjs)$/i;

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

    /* ---------- Envoi ---------- */

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        showFormError('');

        const name = nameInput.value.trim();
        if (!name) { showFormError('Donnez un nom au projet.'); nameInput.focus(); return; }
        if (!fileInput.files[0]) return showFormError('Choisissez un fichier de base.');

        submit.disabled = true;
        submit.textContent = 'Création en cours…';
        resultBody.replaceChildren(h('h2', { text: 'Envoi du fichier' }), h('p', { class: 'muted', text: 'Analyse du fichier…' }));

        try {
            const res = await fetch('/api/projects/upload', { method: 'POST', body: new FormData(form) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

            window.location.href = `/projects/${data.id}`;
        } catch (err) {
            resultBody.replaceChildren(h('h2', { text: 'Résultat' }), h('p', { class: 'muted', text: 'Le projet est créé dès l\'envoi du fichier. Les traductions se lancent ensuite depuis sa page.' }));
            showFormError(err.message);
            submit.disabled = false;
            submit.textContent = 'Créer le projet';
        }
    });

    refreshDrop();
})();