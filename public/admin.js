/* Cake Genius admin dashboard. All data comes from authorized /api/admin/* routes. */

const $ = (s, r = document) => r.querySelector(s);
const money = (n) => `${new Intl.NumberFormat('ar-SA').format(n)} ر.س`;
const dt = (iso) => (iso ? new Date(iso).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'is-visible' + (kind ? ` is-${kind}` : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ''; }, 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let statusFilter = 'all';

function showLogin(msg = '') {
  $('#dashView').style.display = 'none';
  $('#loginView').style.display = 'grid';
  const box = $('#loginError');
  if (msg) { box.textContent = msg; box.classList.add('is-visible'); } else box.classList.remove('is-visible');
}

function showDash(user) {
  $('#loginView').style.display = 'none';
  $('#dashView').style.display = 'block';
  $('#whoami').textContent = `المستخدم: ${user.username}`;
}

async function loadAll() {
  $('#dashError').classList.remove('is-visible');
  $('#ordersBody').innerHTML = '<tr><td colspan="7" class="empty-row">جارٍ التحميل…</td></tr>';
  try {
    const [stats, orders, customers, products] = await Promise.all([
      api('/api/admin/stats'),
      api(`/api/admin/orders?status=${encodeURIComponent(statusFilter)}`),
      api('/api/admin/customers'),
      api('/api/admin/products'),
    ]);
    renderStats(stats.stats);
    renderOrders(orders.orders);
    renderCustomers(customers.customers);
    renderProducts(products.products);
    $('#lastSync').textContent = new Date().toLocaleTimeString('ar-SA');
  } catch (err) {
    if (err.status === 401) return showLogin('انتهت الجلسة. سجّل الدخول مرة أخرى.');
    const box = $('#dashError');
    box.textContent = err.message;
    box.classList.add('is-visible');
  }
}

function renderStats(s) {
  const kpi = [
    ['إجمالي الطلبات', String(s.orders)],
    ['الإيراد التجريبي', money(s.revenue)],
    ['متوسط الطلب', money(s.avgOrder)],
    ['عدد العملاء', String(s.customers)],
    ['قيد الانتظار', String(s.byStatus.pending?.count || 0)],
    ['تم التسليم', String(s.byStatus.delivered?.count || 0)],
  ];
  $('#kpis').innerHTML = kpi.map(([k, v]) => `<div class="kpi"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  $('#revenueBody').innerHTML = s.byDay.length
    ? s.byDay.map((d) => `<tr><td class="mono">${esc(d.day)}</td><td>${esc(d.n)}</td><td>${esc(money(d.amount))}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty-row">لا توجد بيانات إيراد بعد.</td></tr>';
}

function renderOrders(orders) {
  $('#orderCount').textContent = `${orders.length} طلب`;
  if (!orders.length) {
    $('#ordersBody').innerHTML = '<tr><td colspan="7" class="empty-row">لا توجد طلبات مطابقة.</td></tr>';
    return;
  }
  $('#ordersBody').innerHTML = orders.map((o) => {
    const items = o.items.map((it) => `${esc(it.name.ar)} ×${it.quantity} (${esc(it.config.size)}/${esc(it.config.flavor)})`).join('<br>');
    return `<tr data-order="${esc(o.id)}">
      <td class="mono">${esc(o.code)}</td>
      <td>${esc(o.customer.name)}<br><span class="mono" style="color:var(--ink-soft)">${esc(o.customer.phone)}</span></td>
      <td style="font-size:12px">${items}</td>
      <td class="mono" style="font-size:12px">${esc(dt(o.deliveryAt))}</td>
      <td><strong>${esc(money(o.total))}</strong></td>
      <td>
        <span class="badge ${esc(o.status)}" data-badge>${esc(o.status)}</span><br>
        <select class="status-select" data-status="${esc(o.id)}" style="margin-block-start:6px">
          ${['pending', 'confirmed', 'baking', 'ready', 'delivered', 'cancelled']
            .map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="mono" style="font-size:12px">${esc(dt(o.createdAt))}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('[data-status]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const id = e.target.dataset.status;
      const status = e.target.value;
      e.target.disabled = true;
      try {
        await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: { status } });
        const row = e.target.closest('tr');
        const badge = row.querySelector('[data-badge]');
        badge.className = `badge ${status}`;
        badge.textContent = status;
        toast('تم تحديث الحالة', 'ok');
        const stats = await api('/api/admin/stats');
        renderStats(stats.stats);
      } catch (err) {
        toast(err.message, 'error');
        if (err.status === 401) showLogin('انتهت الجلسة.');
      } finally {
        e.target.disabled = false;
      }
    });
  });
}

function renderCustomers(customers) {
  $('#customersBody').innerHTML = customers.length
    ? customers.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td class="mono">${esc(c.phone)}</td>
        <td>${esc(c.email || '—')}</td>
        <td>${esc(c.orders)}</td>
        <td>${esc(money(c.spent))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty-row">لا يوجد عملاء بعد.</td></tr>';
}

function renderProducts(products) {
  $('#productsBody').innerHTML = products.map((p) => `<tr data-product="${esc(p.id)}">
      <td>${esc(p.name.ar)}<br><span class="mono" style="color:var(--ink-soft)">${esc(p.id)}</span></td>
      <td>${esc(p.category)}</td>
      <td><input type="number" min="20" max="5000" step="5" value="${esc(p.basePrice)}" style="max-width:120px" /></td>
      <td><button class="btn btn-sm btn-ghost" type="button">حفظ</button></td>
    </tr>`).join('');

  document.querySelectorAll('[data-product]').forEach((row) => {
    row.querySelector('button').addEventListener('click', async () => {
      const input = row.querySelector('input');
      try {
        await api(`/api/admin/products/${row.dataset.product}`, { method: 'PATCH', body: { basePrice: Number(input.value) } });
        toast('تم تحديث السعر', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> جارٍ الدخول…';
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: { username: $('#username').value, password: $('#password').value },
    });
    $('#password').value = '';
    showDash(data.user);
    await loadAll();
  } catch (err) {
    $('#loginError').textContent = err.status === 429 ? 'محاولات كثيرة. انتظر 10 دقائق.' : 'بيانات الدخول غير صحيحة.';
    $('#loginError').classList.add('is-visible');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
  showLogin();
});

$('#refreshBtn').addEventListener('click', loadAll);
$('#statusFilter').addEventListener('change', (e) => {
  statusFilter = e.target.value;
  loadAll();
});

(async function init() {
  try {
    const me = await api('/api/admin/me');
    showDash(me.user);
    await loadAll();
  } catch {
    showLogin();
  }
})();
