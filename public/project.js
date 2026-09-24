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

            const nodes = [
                h('p', { class: 'notice', text: `Ajouté${data.addedKeys.length > 1 ? 'es' : 'e'} : ${data.addedKeys.join(', ')}.` }),
            ];
            if (data.errors.length) {
                nodes.push(h('ul', { class: 'issues' }, data.errors.map((e) => h('li', { text: `${e.lang} : ${e.message}` }))));
            }
            if (data.warnings.length) {
                nodes.push(h('details', { class: 'warnings' },
                    h('summary', { text: `${data.warnings.length} avertissement${data.warnings.length > 1 ? 's' : ''}` }),
                    h('ul', {}, data.warnings.map((w) => h('li', { text: `${w.lang} : ${w.message}` })))));
            }
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