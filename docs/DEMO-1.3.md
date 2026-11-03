# عرض 1.3 — دليل التشغيل والتحقق

- الفرع: `studio/cake-genius-1.3/devops`
- الحالة: **NOT DEPLOYED** — كل ما هنا محلي فقط.
- لا خدمة Render، ولا قاعدة بيانات خارجية، ولا نطاق، ولا سر إنتاج لُمس في هذا العمل.

## ما الذي يتغيّر في 1.3

| الطبقة | التغيير |
| --- | --- |
| عقد `/api/slots` | كل فترة تحمل `reason` و`disabled`، و`leadHours` رقمي في الجذر أو في كل يوم، والجذر يحمل `nextAvailable` |
| `nextAvailable` | `{date, windowId, start, label, remaining}` أو `null` عندما لا توجد فترة قابلة للحجز |
| الواجهة | استخراج منطق منتقي الفترات إلى `public/slots-picker.js` مع اختبار مستقل |
| الاختبارات | `tests/availability.test.mjs` و`tests/slots-picker.test.mjs` |

بوابة 1.3 بلا مفتاح `e2e`: مواصفة المتصفح في 1.2 تستهدف الحقل القديم الذي استُبدل، وQA يملك المواصفة البديلة. لا نُبقي مواصفة تشير إلى واجهة لم تعد موجودة.

## التشغيل المحلي

```bash
cd C:/Users/Zulik/cake-genius
PORT=8792 HOST=127.0.0.1 ADMIN_PASSWORD=gate-pass \
  PUBLIC_URL=http://127.0.0.1:8792 node server.js
```

ثم افتح `http://127.0.0.1:8792`، وتحقّق من `http://127.0.0.1:8792/api/health`. في PowerShell اكتب المتغيرات بـ `$env:PORT=8792` وشبيهاتها قبل `node server.js`. قاعدة البيانات الافتراضية `./data/cake.db` (SQLite عبر `node:sqlite`)، ولا يحتاج التطبيق أي `npm install`.

## فحص العرض

```bash
cd C:/Users/Zulik/cake-genius
node scripts/demo-check.mjs
```

السكربت مستقل تماماً (بدون اعتماديات): يطلب منفذاً حرّاً من نظام التشغيل، ينشئ قاعدة مؤقتة تحت `os.tmpdir()`، يشغّل `server.js` نفسه، ثم يقتل العملية وينظّف الملفات في `finally`.
لتحجيم فترة إلى كعكة واحدة يستخدم `PATCH /api/admin/settings` بجلسة مشرف (`capacity.perWindow=1` و`capacity.daily=50`) قبل قراءة الفترات — خيار حتمي واحد بدل ستة حجوزات عمياء، ويثبت مسار السعة الإداري الذي يعتمد عليه العرض.

## كيف تقرأ المخرجات

```
PASS  slots contract: every window carries a reason
FAIL  slots contract: root exposes nextAvailable -> nextAvailable key missing
```

كل تحقق يطبع سطراً واحداً، وآخر سطر هو `DEMO CHECK: PASS` أو `DEMO CHECK: FAIL`، ورمز الخروج صفر فقط عند النجاح. ترتيب التحققات: صحة الخدمة، عقد الفترات، `nextAvailable`، الحجز 201، القراءة بالرمز نفسه، امتلاء الفترة، ثم الرفض 409 `SLOT_FULL`، وأخيراً إغلاق المنفذ.

## ما يثبته الدليل

- الخادم يقلع على قاعدة فارغة بدون أي حزمة خارجية ويجيب `/api/health`.
- `/api/slots` يحمل حقول 1.3 كاملة، و`nextAvailable` إما `null` أو فترة قابلة للحجز فعلاً.
- الحجز في `nextAvailable` يعيد 201، والطلب يُقرأ بـ `POST /api/orders/lookup` بالرمز والجوال نفسيهما.
- فترة `remaining = 0` ترفض الحجز الثاني بـ 409 `SLOT_FULL`، ولا تبقى عملية خادم بعد الفحص.

## حالة الفحص قبل دمج 1.3

هذه الحزمة تخص DevOps فقط، وتغييرات الخادم والواجهة في 1.3 لم تُدمج بعد. لذلك يمرّ الفحص على سلوك 1.2 في 12 تحققاً، ويفشل في أربعة حقول جديدة كما هو متوقع:

- `slots contract: every window carries a reason` → `missing reason on: w1, w2`
- `slots contract: exposes numeric leadHours (root or every day)` → `root=undefined, days with leadHours=0/14`
- `slots contract: root exposes nextAvailable` → `nextAvailable key missing`
- `slots: nextAvailable is null or a bookable window` → `nextAvailable key missing`

لم تُخفَّف هذه التحققات لتُرضي القاعدة القديمة؛ تُصلَح بدمج تغيير 1.3 ثم إعادة التشغيل. وبوابة 1.3 لا تكتمل قبل الدمج أيضاً، لأن `public/slots-picker.js` و`tests/availability.test.mjs` غير موجودين في حزمة DevOps. أما مسار الحجز والرفض 409 فقد أُثبت فعلياً على القاعدة الحالية عبر أول فترة قابلة للحجز.

## NOT DEPLOYED

**لم يُنشر شيء.** النشر يحتاج موافقة المالك الصريحة، ولم تُنشأ أي خدمة Render أو قاعدة بيانات أو نطاق، ولم تُعدَّل `render.yaml` ولا متغيرات بيئة الإنتاج. بوابة 1.3 محددة بـ `deployment: "none"` و`ci: false` و`github: null` و`live: null`، فلا مرحلة نشر ولا دفع ولا فتح مورد سحابي.

بوابة 1.3: `vlab gate --config gate.config.cake-genius-1.3.json`. آخر تشغيل على مرشّح مُجمَّع من الفروع الثلاثة: المراحل 1 و2 و3.1 و3.2 و4 و7.1 **PASS**، والمرحلة 3 (E2E) **FAIL — no tests found** لغياب مواصفة 1.3 التي يملكها QA، فالحكم **BLOCKED**؛ التقرير `verification-lab/out/gate-cake-genius-1.3-candidate-2026-11-03T02-03-39-112Z.json`. وعلى مسار الدمج الحالي تفشل المرحلتان 1 و2 لأن فروع 1.3 لم تُدمج بعد (`gate-cake-genius-1.3-studio-2026-11-03T02-04-43-737Z.json`).
