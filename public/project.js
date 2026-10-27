(() => {
    'use strict';

    const script = document.currentScript;
    const projectId = script.dataset.id;

    const form = document.getElementById('add-keys-form');
    const textarea = document.getElementById('snippet');
    const submit = document.getElementById('add-keys-submit');
    const error = document.getElementById('keys-error');
    const result = document.getElementById('keys-result');

    function showError(message) {
        error.textContent = message || '';
        error.hidden = !message;
    }

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

    /* ---------- Traductions vers de nouvelles langues ---------- */

    const tForm = document.getElementById('translate-form');
    const tSubmit = document.getElementById('translate-submit');
    const tError = document.getElementById('translate-error');
    const tStatus = document.getElementById('translate-status');
    const filesList = document.querySelector('ul.files');
    const langLabels = [...document.querySelectorAll('.lang')];
    const boxes = langLabels.map((label) => label.querySelector('input'));
    const counter = document.getElementById('lang-count');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let polling = false;

    function updateCount() {
        const n = boxes.filter((c) => c.checked).length;
        counter.textContent = `${n} ${n > 1 ? 'langues choisies' : 'langue choisie'}`;
    }
    document.getElementById('lang-filter').addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        for (const label of langLabels) label.hidden = Boolean(label.dataset.taken) || (query !== '' && !label.dataset.search.includes(query));
    });
    document.getElementById('select-visible').addEventListener('click', () => {
        langLabels.forEach((label, i) => { if (!label.hidden && !label.dataset.taken) boxes[i].checked = true; });
        updateCount();
    });
    document.getElementById('clear-all').addEventListener('click', () => { boxes.forEach((c) => { c.checked = false; }); updateCount(); });
    boxes.forEach((c) => c.addEventListener('change', updateCount));

    // Les langues terminées ou en file d'attente ne sont plus proposées ; les fichiers prêts apparaissent dans la liste.
    function syncPage(status) {
        const taken = new Set([...status.targetCodes, ...status.pending]);
        langLabels.forEach((label, i) => {
            label.hidden = taken.has(label.dataset.code) || label.hidden;
            if (taken.has(label.dataset.code)) { label.dataset.taken = '1'; boxes[i].checked = false; }
        });
        updateCount();
        for (const code of status.targetCodes) {
            if (filesList.querySelector(`[data-code="${code}"]`)) continue;
            filesList.append(h('li', { class: 'file', 'data-code': code },
                h('div', { class: 'file-main' }, h('span', { class: 'file-name', text: `${code}${scriptExt}` })),
                h('a', { class: 'btn btn-small', href: `/api/projects/${projectId}/files/${code}`, download: true, text: 'Télécharger' })));
        }
    }
    const scriptExt = filesList.querySelector('.file-name')?.textContent.trim().match(/\.\w+$/)?.[0] ?? '';

    function showStatus(status) {
        const nodes = [];
        if (status.running) {
            const percent = status.total ? Math.min(100, Math.round((status.done / status.total) * 100)) : 0;
            const fill = h('span');
            fill.style.width = `${percent}%`;
            nodes.push(
                h('h3', { text: 'Traduction en cours' }),
                h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }, fill),
                h('p', { class: 'muted', text: `${status.done} sur ${status.total} textes · en cours ou en attente : ${status.pending.join(', ')}` }),
            );
        } else if (status.hasTask) {
            nodes.push(h('p', { class: 'notice', text: status.errors.length ? 'Traduction terminée, avec des erreurs.' : 'Traduction terminée.' }));
        }
        if (status.errors.length) nodes.push(h('ul', { class: 'issues' }, status.errors.map((e) => h('li', { text: `${e.label ?? e.lang} : ${e.message}` }))));
        if (status.warningsTotal) {
            nodes.push(h('details', { class: 'warnings' },
                h('summary', { text: `${status.warningsTotal} texte${status.warningsTotal > 1 ? 's' : ''} conservé${status.warningsTotal > 1 ? 's' : ''} tel${status.warningsTotal > 1 ? 's' : ''} quel${status.warningsTotal > 1 ? 's' : ''} (détail dans translation-errors.log)` }),
                h('ul', {}, [...status.warnings.map((w) => h('li', { text: `${w.lang ? `${w.lang}, ` : ''}${w.path} : ${w.message}` })),
                status.warningsTotal > status.warnings.length ? h('li', { text: `… et ${status.warningsTotal - status.warnings.length} autres` }) : null])));
        }
        tStatus.replaceChildren(...nodes);
    }

    // Suit la traduction jusqu'au bout. Reprend tout seul si la page est rechargée ou si le serveur a redémarré.
    async function follow() {
        if (polling) return;
        polling = true;
        let failures = 0;
        try {
            for (; ;) {
                try {
                    const res = await fetch(`/api/projects/${projectId}/status`);
                    if (!res.ok) throw new Error(`Erreur ${res.status}`);
                    const status = await res.json();
                    failures = 0;
                    syncPage(status);
                    showStatus(status);
                    if (!status.running) return;
                } catch (err) {
                    if (++failures >= 5) { tError.textContent = `Suivi interrompu (${err.message}). Rechargez la page pour reprendre.`; tError.hidden = false; return; }
                }
                await sleep(1000);
            }
        } finally {
            polling = false;
        }
    }

    tForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        tError.hidden = true;
        const targets = boxes.filter((c) => c.checked).map((c) => c.value);
        if (targets.length === 0) { tError.textContent = 'Choisissez au moins une langue.'; tError.hidden = false; return; }

        tSubmit.disabled = true;
        try {
            const res = await fetch(`/api/projects/${projectId}/translate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targets }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
            syncPage(data);
            showStatus(data);
            follow();
        } catch (err) {
            tError.textContent = err.message;
            tError.hidden = false;
        } finally {
            tSubmit.disabled = false;
        }
    });

    follow(); // reprend le suivi d'une traduction déjà en cours

    /* ---------- Ajout de clés ---------- */

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        showError('');
        result.replaceChildren();

        const snippet = textarea.value.trim();
        if (!snippet) return showError('Entrez au moins une clé.');

        submit.disabled = true;
        submit.textContent = 'Traduction en cours…';

        try {
            const res = await fetch(`/api/projects/${projectId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snippet }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

            const nodes = [h('p', { class: 'notice', text: `Ajouté${data.addedKeys.length > 1 ? 'es' : 'e'} : ${data.addedKeys.join(', ')}.` })];
            if (data.errors.length) {
                nodes.push(h('ul', { class: 'issues' }, data.errors.map((e) => h('li', { text: `${e.lang} : ${e.message}` }))));
            }
            if (data.warnings.length) nodes.push(h('details', { class: 'warnings' }, h('summary', { text: `${data.warnings.length} avertissement${data.warnings.length > 1 ? 's' : ''}` }), h('ul', {}, data.warnings.map((w) => h('li', { text: `${w.lang} : ${w.message}` })))));
            result.replaceChildren(...nodes);
            textarea.value = '';
            setTimeout(() => window.location.reload(), 1200); // pour retélécharger les fichiers à jour
        } catch (err) {
            showError(err.message);
        } finally {
            submit.disabled = false;
            submit.textContent = 'Traduire et ajouter';
        }
    });
})();