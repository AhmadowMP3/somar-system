/** Reference data used by the demo seed, the import-file generator and the test suites. */

export const DEMO_UNIVERSITY = {
  name: 'سومر تورز — جامعة الشهباء الخاصة',
  transport_prefix: 'SHB',
  week_start_dow: 6,
};

export const COLLEGES = ['كلية طب الاسنان', 'كلية هندسة معلومات', 'ادارة الاعمال'];

export const AREAS = [
  '3000 شقة',
  'اشارات الشهباء',
  'اشارات سوق سيف دولة',
  'اشارات سيرياتيل',
  'اشارات نيوتاون',
  'ال 1070 شقة',
  'الدوار المائل',
  'الرجاء',
  'السريان',
  'الصنم',
  'المهندسين',
  'انصاري شرقي',
  'اوتستراد الحمدانية',
  'جامع التوحيد',
  'جامع الرحمن',
  'جامع النصر',
  'جسر الحج',
  'جوية',
  'دوار الدلة',
  'دوار الشرطة',
  'دوار الشفاء',
  'دوار الصخرة',
  'دوار الطب العربي',
  'دوار العمارة',
  'دوار الكرة',
  'دوار الكلمة الاشرفية',
  'دوار الموت',
  'دوار عمر ابوريشة',
  'ساحة جامعة',
  'ساحة سعد الله جابري',
  'صحة',
  'قرطبة',
  'كازية الشياح',
  'مالية',
  'محطة الاكسبريس',
  'مستودعات الاعظمية',
  'مسمكة ابوجاسم',
  'مشفى النحاس',
  'مولات سيف دولة',
];

export const PACKAGES = [
  { name: '3 أيام أسبوعياً', trips_per_week: 3, price: 150000 },
  { name: '4 أيام أسبوعياً', trips_per_week: 4, price: 190000 },
  { name: '5 أيام أسبوعياً', trips_per_week: 5, price: 230000 },
  { name: '6 أيام أسبوعياً', trips_per_week: 6, price: 270000 },
];

export const FIRST_NAMES_M = ['محمد', 'أحمد', 'علي', 'عمر', 'خالد', 'يوسف', 'حسن', 'مصطفى', 'إبراهيم', 'عبد الله', 'سامر', 'ماهر', 'رامي', 'باسل', 'طارق', 'فادي', 'زيد', 'قصي', 'حمزة', 'أنس'];
export const FIRST_NAMES_F = ['فاطمة', 'مريم', 'سارة', 'نور', 'هبة', 'رنا', 'لين', 'ريم', 'آية', 'دعاء', 'جنى', 'شهد', 'بتول', 'رهف', 'سلمى', 'تسنيم', 'ليلى', 'يارا', 'حلا', 'غنى'];
export const FATHER_NAMES = ['محمد', 'أحمد', 'محمود', 'عبد الرحمن', 'حسين', 'جمال', 'سمير', 'وليد', 'نبيل', 'فيصل', 'عادل', 'منير'];
export const FAMILY_NAMES = ['الحلبي', 'الأحمد', 'الخطيب', 'العلي', 'الشامي', 'السيد', 'النجار', 'الحداد', 'قباني', 'الزعبي', 'الجاسم', 'المصري', 'الحسن', 'العمر', 'البكري', 'الدباغ', 'طرابيشي', 'الكردي', 'حمامي', 'شيخ الأرض'];

/** Free-text "other" areas typed by students (exercise the mapping screen). */
export const OTHER_AREAS = ['حي الفرقان', 'الحمدانية الجديدة', 'حلب الجديدة شمالي', 'الشعار'];

export const SHIFT_LABELS: Record<string, string> = {
  '08:00': 'الساعة ٨ صباحا',
  '10:00': 'الساعة ال ١٠ صباحا',
  '12:00': 'الساعة ال ١٢ ظهرا',
  '14:00': 'الساعة الثانية ظهرا',
};

export const DAY_LABELS: Record<number, string> = {
  1: 'الاثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
  7: 'الأحد',
};

/** Aleppo stop coordinates (approximate) used for routes and scan jitter. */
export const STOPS: { name: string; lat: number; lng: number }[] = [
  { name: 'دوار الشفاء', lat: 36.2152, lng: 37.1251 },
  { name: 'جامع الرحمن', lat: 36.2112, lng: 37.1312 },
  { name: 'ساحة جامعة', lat: 36.2021, lng: 37.1343 },
  { name: 'دوار الموت', lat: 36.2231, lng: 37.1098 },
  { name: 'اشارات الشهباء', lat: 36.2289, lng: 37.1182 },
  { name: 'المهندسين', lat: 36.2055, lng: 37.1177 },
  { name: 'جامع التوحيد', lat: 36.2178, lng: 37.1421 },
  { name: 'مولات سيف دولة', lat: 36.1962, lng: 37.1487 },
  { name: 'محطة الاكسبريس', lat: 36.2085, lng: 37.1552 },
  { name: 'الصنم', lat: 36.1985, lng: 37.1622 },
  { name: 'جسر الحج', lat: 36.1893, lng: 37.1561 },
  { name: 'دوار الصخرة', lat: 36.2248, lng: 37.1301 },
  { name: 'قرطبة', lat: 36.2129, lng: 37.1646 },
  { name: 'الرجاء', lat: 36.2322, lng: 37.1389 },
  { name: 'مسمكة ابوجاسم', lat: 36.2011, lng: 37.1022 },
  { name: 'حرم جامعة الشهباء', lat: 36.1781, lng: 37.0741 },
];

/** Deterministic pseudo-random generator so the seed is reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}
