// Community announcements + password-protected admin editor.
// Data lives in the "twin-chimneys-announcements" Cloudflare Worker (see announcements-api/).
(() => {
  const section = document.getElementById('announcements');
  if (!section) return;

  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = (isLocal ? 'http://localhost:8787' : section.dataset.api || '').replace(/\/+$/, '');
  const TOKEN_KEY = 'tc-admin-token';

  const $ = (sel) => section.querySelector(sel);
  const listEl = $('#announcements-list');
  const emptyEl = $('#announcements-empty');
  const adminToggle = $('#admin-toggle');
  const loginForm = $('#admin-login');
  const loginError = $('#admin-login-error');
  const panel = $('#admin-panel');
  const editForm = $('#announcement-form');
  const formError = $('#announcement-error');
  const formTitle = $('#announcement-form-title');
  const linksEl = $('#announcement-links');
  const adminList = $('#admin-list');
  const cancelEdit = $('#announcement-cancel');
  const saveBtn = $('#announcement-save');

  let editingId = null;
  let adminItems = [];

  // ---------- helpers ----------
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) if (child != null) node.append(child);
    return node;
  };

  const getToken = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
      return saved && saved.expires > Date.now() ? saved.token : null;
    } catch (_) { return null; }
  };
  const setToken = (value) => {
    try { value ? sessionStorage.setItem(TOKEN_KEY, JSON.stringify(value)) : sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
  };

  async function api(path, options = {}) {
    if (!API) throw new Error('Announcements are not connected yet.');
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token && path.startsWith('/admin')) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(API + path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path.startsWith('/admin')) { signOut(); throw new Error(data.error || 'Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  const formatDate = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    return isNaN(d) ? iso : d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  };

  function renderAnnouncement(item) {
    const links = (item.links || []).map((link) => {
      const external = /^https?:/i.test(link.url);
      return el('a', {
        href: link.url,
        textContent: link.label + (external ? ' ↗' : ''),
        className: 'announcement-link',
        ...(external ? { target: '_blank', rel: 'noopener' } : {}),
      });
    });
    return el('article', { className: 'announcement' }, [
      item.title ? el('h3', { textContent: item.title }) : null,
      item.message ? el('p', { textContent: item.message }) : null,
      links.length ? el('div', { className: 'announcement-links' }, links) : null,
    ]);
  }

  // ---------- public list ----------
  async function loadPublic() {
    try {
      const { items } = await api('/announcements');
      listEl.replaceChildren(...items.map(renderAnnouncement));
      emptyEl.hidden = items.length > 0;
      section.classList.toggle('has-items', items.length > 0);
    } catch (err) {
      listEl.replaceChildren();
      emptyEl.hidden = false;
      section.classList.remove('has-items');
      console.warn('Announcements unavailable:', err.message);
    }
  }

  // ---------- admin ----------
  function showAdmin(open) {
    const signedIn = Boolean(getToken());
    loginForm.hidden = !open || signedIn;
    panel.hidden = !open || !signedIn;
    adminToggle.textContent = signedIn ? (open ? 'Close admin' : 'Manage announcements') : (open ? 'Close' : 'Admin login');
    adminToggle.setAttribute('aria-expanded', String(open));
    if (open && !signedIn) loginForm.querySelector('input').focus();
    if (open && signedIn) loadAdmin();
  }

  function signOut() {
    setToken(null);
    resetForm();
    showAdmin(false);
  }

  function addLinkRow(link = { label: '', url: '' }) {
    if (linksEl.children.length >= 5) return;
    const row = el('div', { className: 'link-row' }, [
      el('input', { type: 'text', placeholder: 'Link text (e.g. Sign-up form)', value: link.label, maxLength: 80, ariaLabel: 'Link text' }),
      el('input', { type: 'text', placeholder: 'https://… or email address', value: link.url.replace(/^mailto:/, ''), maxLength: 600, ariaLabel: 'Link address' }),
      el('button', { type: 'button', className: 'link-remove', textContent: 'Remove', onclick: () => row.remove() }),
    ]);
    linksEl.append(row);
  }

  function resetForm() {
    editingId = null;
    editForm.reset();
    linksEl.replaceChildren();
    formError.textContent = '';
    formTitle.textContent = 'New announcement';
    saveBtn.textContent = 'Post announcement';
    cancelEdit.hidden = true;
  }

  function startEdit(item) {
    resetForm();
    editingId = item.id;
    editForm.elements.title.value = item.title || '';
    editForm.elements.message.value = item.message || '';
    editForm.elements.expires.value = item.expires || '';
    (item.links || []).forEach(addLinkRow);
    formTitle.textContent = 'Edit announcement';
    saveBtn.textContent = 'Save changes';
    cancelEdit.hidden = false;
    editForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    editForm.elements.title.focus();
  }

  async function loadAdmin() {
    adminList.replaceChildren(el('p', { className: 'admin-muted', textContent: 'Loading…' }));
    try {
      const { items } = await api('/admin/announcements');
      adminItems = items;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
      if (!items.length) {
        adminList.replaceChildren(el('p', { className: 'admin-muted', textContent: 'No announcements yet. Your first one will appear on the home page right away.' }));
        return;
      }
      adminList.replaceChildren(...items.map((item) => {
        const expired = item.expires && item.expires < today;
        const status = expired ? `Hidden — ended ${formatDate(item.expires)}` : item.expires ? `Showing until ${formatDate(item.expires)}` : 'Showing';
        return el('li', { className: expired ? 'is-expired' : '' }, [
          el('div', {}, [
            el('b', { textContent: item.title || item.message.slice(0, 60) || (item.links[0] && item.links[0].label) || 'Untitled' }),
            el('span', { textContent: status }),
          ]),
          el('div', { className: 'admin-actions' }, [
            el('button', { type: 'button', textContent: 'Edit', onclick: () => startEdit(item) }),
            el('button', { type: 'button', className: 'danger', textContent: 'Delete', onclick: () => remove(item) }),
          ]),
        ]);
      }));
    } catch (err) {
      adminList.replaceChildren(el('p', { className: 'admin-error', textContent: err.message }));
    }
  }

  async function remove(item) {
    if (!confirm(`Delete “${item.title || 'this announcement'}”? This cannot be undone.`)) return;
    try {
      await api(`/admin/announcements/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (editingId === item.id) resetForm();
      await Promise.all([loadAdmin(), loadPublic()]);
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- events ----------
  adminToggle.addEventListener('click', () => showAdmin(adminToggle.getAttribute('aria-expanded') !== 'true'));

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    const button = loginForm.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const data = await api('/login', { method: 'POST', body: JSON.stringify({ password: loginForm.elements.password.value }) });
      setToken(data);
      loginForm.reset();
      showAdmin(true);
    } catch (err) {
      loginError.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#admin-signout').addEventListener('click', signOut);
  $('#add-link').addEventListener('click', () => addLinkRow());
  cancelEdit.addEventListener('click', resetForm);

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.textContent = '';
    const links = [...linksEl.querySelectorAll('.link-row')].map((row) => {
      const [label, url] = row.querySelectorAll('input');
      return { label: label.value, url: url.value };
    });
    const body = JSON.stringify({
      title: editForm.elements.title.value,
      message: editForm.elements.message.value,
      expires: editForm.elements.expires.value,
      links,
    });
    saveBtn.disabled = true;
    try {
      if (editingId) await api(`/admin/announcements/${encodeURIComponent(editingId)}`, { method: 'PUT', body });
      else await api('/admin/announcements', { method: 'POST', body });
      resetForm();
      await Promise.all([loadAdmin(), loadPublic()]);
    } catch (err) {
      formError.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  showAdmin(false);
  loadPublic();
})();
