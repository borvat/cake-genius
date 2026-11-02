/* 1.2 operations: day board, capacity settings, product creation, WhatsApp preview.
   Split from admin.js so the 1.1 dashboard keeps its structure; the two talk
   through the 'cg:admin-ready' event. */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${new Intl.NumberFormat('ar-SA').format(n)} ر.س`;
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }) : '—');
const dayKey = (d = new Date()) => new Date(d.getTime() + 180 * 60000).toISOString().slice(0, 10);

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

function flash(el, msg, kind = 'error') {
  el.textContent = msg;
  el.className = `alert alert-${kind} is-visible`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'alert'; }, 4000);
}

/* ------------------------------ day board ------------------------------ */

function renderSlots(a) {
  const chips = a.windows.map((w) => `
    <span class="slot-chip ${w.disabled ? 'is-full' : ''}">
      <strong dir="ltr">${esc(w.label)}</strong>
      <span>${w.booked}/${w.capacity}</span>
    </span>`).join('');
  $('#daySlots').innerHTML = `
    <span class="slot-chip ${a.remaining === 0 ? 'is-full' : ''}">
      <strong>اليوم كله</strong><span>${a.dayBooked}/${a.dayCapacity}</span>
    </span>${chips}${a.closed ? '<span class="slot-chip is-full"><strong>مغلق</strong></span>' : ''}`;
  $('#daySummary').textContent = `${a.remaining} متاح من ${a.dayCapacity}`;
}

function orderRow(o) {
  const items = o.items.map((it) => `${esc(it.name.ar)} ×${it.quantity}`).join('<br>');
  return `<tr data-order="${esc(o.id)}">
    <td class="mono">${esc(time(o.deliveryAt))}</td>
    <td class="mono">${esc(o.code)}</td>
    <td>${esc(o.customer.name)}<br><span class="mono" style="color:var(--ink-soft)">${esc(o.customer.phone)}</span></td>
    <td style="font-size:12px">${items}</td>
    <td>
      <span class="badge ${esc(o.status)}" data-badge>${esc(o.status)}</span>
      <select class="status-select" data-status="${esc(o.id)}" aria-label="حالة ${esc(o.code)}">
        ${['pending', 'confirmed', 'baking', 'ready', 'delivered', 'cancelled']
          .map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
    </td>
    <td><strong>${esc(money(o.total))}</strong></td>
    <td><button class="btn btn-sm btn-ghost" type="button" data-notify="${esc(o.id)}">معاينة</button></td>
  </tr>`;
}

async function loadDay() {
  const date = $('#dayDate').value || dayKey();
  try {
    const data = await api(`/api/admin/day?date=${encodeURIComponent(date)}`);
    renderSlots(data.availability);
    $('#dayBody').innerHTML = data.orders.length
      ? data.orders.map(orderRow).join('')
      : '<tr><td colspan="7" class="empty-row">لا توجد طلبات في هذا اليوم.</td></tr>';

    document.querySelectorAll('#dayBody [data-status]').forEach((sel) => {
      sel.addEventListener('change', async (e) => {
        const id = e.target.dataset.status;
        try {
          await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: { status: e.target.value } });
          await loadDay();
        } catch (err) {
          flash($('#dashError'), err.message);
        }
      });
    });
    document.querySelectorAll('#dayBody [data-notify]').forEach((btn) => {
      btn.addEventListener('click', () => previewNotify(btn.dataset.notify));
    });
  } catch (err) {
    flash($('#dashError'), err.message);
  }
}

/* ----------------------------- notifications ---------------------------- */

async function previewNotify(orderId) {
  try {
    const data = await api(`/api/admin/orders/${orderId}/notify-preview`, { method: 'POST' });
    const msg = data.messages.customer;
    $('#notifyChannel').textContent = data.channel.armed
      ? 'القناة مهيّأة للإرسال التلقائي.'
      : 'القناة غير مفعّلة: الإرسال التلقائي متوقف، وهذا النص للمعاينة والاستخدام اليدوي.';
    $('#notifyBody').textContent = msg?.body || 'لا توجد رسالة (رقم هاتف غير صالح).';
    const link = $('#notifyLink');
    if (data.links.customer) { link.href = data.links.customer; link.style.display = ''; } else { link.style.display = 'none'; }
    $('#notifyModal').classList.add('is-open');
  } catch (err) {
    flash($('#dashError'), err.message);
  }
}

/* ------------------------------- settings ------------------------------- */

const SETTING_FIELDS = [
  ['setDaily', 'capacity.daily'], ['setPerWindow', 'capacity.perWindow'], ['setLead', 'capacity.leadHours'],
  ['setWindows', 'capacity.windows'], ['setClosed', 'capacity.closedDays'],
  ['setPhone', 'shop.phone'], ['setOwner', 'notify.ownerPhone'], ['setUrl', 'shop.url'],
];

async function loadSettings() {
  try {
    const data = await api('/api/admin/settings');
    for (const [id, key] of SETTING_FIELDS) {
      const el = $(`#${id}`);
      if (el && data.settings[key] !== undefined) el.value = data.settings[key];
    }
    const wa = data.settings.notify;
    $('#waStatus').textContent = `قناة واتساب: ${wa.provider} — ${wa.armed ? 'مفعّلة' : 'غير مفعّلة'}. النصوص تُولَّد وتُخزَّن في صندوق الصادر ولا تُرسل.`;
  } catch (err) {
    flash($('#settingsErr'), err.message);
  }
}

async function saveSettings() {
  const body = {};
  for (const [id, key] of SETTING_FIELDS) {
    const el = $(`#${id}`);
    if (!el) continue;
    body[key] = el.type === 'number' ? Number(el.value) : el.value;
  }
  try {
    await api('/api/admin/settings', { method: 'PATCH', body });
    flash($('#settingsOk'), 'حُفظت الإعدادات، والسعة الجديدة تُطبَّق من الآن.', 'ok');
    await loadDay();
  } catch (err) {
    flash($('#settingsErr'), err.message);
  }
}

/* ------------------------------ new product ----------------------------- */

function openProduct() {
  $('#productErr').classList.remove('is-visible');
  $('#productForm').reset();
  $('#productModal').classList.add('is-open');
  $('#pSlug').focus();
}

async function submitProduct(e) {
  e.preventDefault();
  const body = {
    slug: $('#pSlug').value.trim(),
    category: $('#pCategory').value.trim(),
    nameAr: $('#pNameAr').value.trim(),
    nameEn: $('#pNameEn').value.trim(),
    descAr: $('#pDescAr').value.trim(),
    descEn: $('#pDescEn').value.trim(),
    basePrice: Number($('#pPrice').value),
    ...($('#pImage').value.trim() ? { image: $('#pImage').value.trim() } : {}),
  };
  try {
    await api('/api/admin/products', { method: 'POST', body });
    $('#productModal').classList.remove('is-open');
    $('#productErr').classList.remove('is-visible');
    if (window.cgReload) await window.cgReload();
  } catch (err) {
    flash($('#productErr'), err.message);
  }
}

/* -------------------------------- wiring -------------------------------- */

let wired = false;
function init() {
  if (wired) return;
  wired = true;
  $('#dayDate').value = dayKey();
  $('#dayDate').addEventListener('change', loadDay);
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#newProductBtn').addEventListener('click', openProduct);
  $('#productForm').addEventListener('submit', submitProduct);
  $('#productModalClose').addEventListener('click', () => $('#productModal').classList.remove('is-open'));
  $('#notifyClose').addEventListener('click', () => $('#notifyModal').classList.remove('is-open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal.is-open').forEach((m) => m.classList.remove('is-open'));
  });
  loadSettings();
  loadDay();
}

window.addEventListener('cg:admin-ready', init);
// admin.js dispatches after its first successful load; if it already ran
// before this module executed, init once on DOMContentLoaded as a fallback.
document.addEventListener('DOMContentLoaded', () => {
  if ($('#dashView') && $('#dashView').style.display !== 'none') init();
});
