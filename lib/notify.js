/**
 * WhatsApp notification preparation. NOTHING IS EVER SENT FROM THIS FILE.
 *
 * It renders the two messages an order needs (customer confirmation + owner
 * alert), stores them in notification_outbox, and exposes a click-to-send
 * wa.me link for a human. Automatic sending needs a Meta WhatsApp Business
 * account, an approved message template and a paid conversation tier, so it is
 * deliberately left disabled until the owner approves that channel.
 */

export function normalizePhone(raw, countryCode = process.env.SHOP_COUNTRY_CODE || '966') {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith(countryCode)) return digits;
  if (digits.startsWith('0')) return countryCode + digits.slice(1);
  return digits;
}

export function whatsappLink(phone, text) {
  const to = normalizePhone(phone);
  if (!to) return null;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export function money(n, currency = 'SAR') {
  const label = currency === 'SAR' ? 'ر.س' : currency;
  return `${new Intl.NumberFormat('ar-SA').format(Number(n) || 0)} ${label}`;
}

function deliveryLine(order) {
  if (!order.deliveryAt) return 'لم يُحدَّد موعد بعد';
  const d = new Date(order.deliveryAt);
  const date = d.toLocaleDateString('ar-SA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Riyadh' });
  const time = d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
  return `${date} - ${time}`;
}

function itemsBlock(order) {
  return order.items
    .map((it) => {
      const size = it.config?.size ? ` (${it.config.size})` : '';
      return `• ${it.name.ar}${size} ×${it.quantity}`;
    })
    .join('\n');
}

/**
 * Returns { customer: {to, template, body}, owner: {to, template, body} }.
 * `owner` is null when no owner phone is configured.
 */
export function renderOrderMessages(order, settings) {
  const shopName = settings?.shop?.nameAr || 'كيك جينيوس';
  const contact = settings?.shop?.phone || '';
  const track = settings?.shop?.url ? `\nمتابعة الطلب: ${settings.shop.url}` : '';

  const customerBody = [
    `مرحباً ${order.customer.name}،`,
    `تم استلام طلبك من ${shopName}.`,
    `رقم الطلب: ${order.code}`,
    `التسليم: ${deliveryLine(order)}`,
    '',
    itemsBlock(order),
    '',
    `الإجمالي: ${money(order.total, order.currency)}`,
    contact ? `للتواصل: ${contact}` : '',
    track.trim(),
  ].filter((l) => l !== '').join('\n');

  const ownerBody = [
    `طلب جديد ${order.code}`,
    `العميل: ${order.customer.name} - ${order.customer.phone}`,
    `التسليم: ${deliveryLine(order)}`,
    '',
    itemsBlock(order),
    '',
    `الإجمالي: ${money(order.total, order.currency)}`,
  ].filter((l) => l !== '').join('\n');

  const ownerPhone = settings?.notify?.ownerPhone || '';
  return {
    customer: { to: normalizePhone(order.customer.phone), template: 'order_confirmation', body: customerBody },
    owner: ownerPhone ? { to: normalizePhone(ownerPhone), template: 'new_order_alert', body: ownerBody } : null,
  };
}

/**
 * Channel readiness, without connecting to anything.
 * `enabled` requires an explicit env opt-in; `configured` requires credentials.
 * Both must be true before any future sender may run.
 */
export function channelStatus(env = process.env) {
  const token = !!env.WHATSAPP_TOKEN;
  const phoneId = !!env.WHATSAPP_PHONE_NUMBER_ID;
  const enabled = env.WHATSAPP_ENABLED === 'true';
  const missing = [];
  if (!token) missing.push('WHATSAPP_TOKEN');
  if (!phoneId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  return {
    provider: 'meta-whatsapp-cloud-api',
    enabled,
    configured: token && phoneId,
    armed: enabled && token && phoneId,
    missing,
    note: 'Messages are rendered and queued only. Nothing is sent automatically; Meta requires a verified business, an approved template and paid conversations.',
  };
}
