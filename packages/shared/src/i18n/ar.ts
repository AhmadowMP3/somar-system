/**
 * Central Arabic dictionary for strings shared by the API and the web app.
 * UI-only strings live in apps/web/src/i18n/ar.ts, which re-exports this module.
 */
export const arShared = {
  days: {
    1: 'الاثنين',
    2: 'الثلاثاء',
    3: 'الأربعاء',
    4: 'الخميس',
    5: 'الجمعة',
    6: 'السبت',
    7: 'الأحد',
  } as Record<number, string>,

  scanCodes: {
    FORBIDDEN: 'غير مصرح لك بإجراء المسح',
    UNKNOWN_QR: 'رمز غير معروف',
    WRONG_UNIVERSITY: 'الطالب لا يتبع لجامعتك',
    STUDENT_INACTIVE: 'حساب الطالب موقوف',
    GEO_REQUIRED: 'يجب تفعيل صلاحية الموقع للمتابعة',
    NO_ACTIVE_SUBSCRIPTION: 'لا يوجد اشتراك فعّال',
    SUBSCRIPTION_EXPIRED: 'انتهى الاشتراك',
    OFFDAY_BLOCKED: 'اليوم ليس من أيام دوام الطالب',
    OVERRIDE_REASON_REQUIRED: 'يجب كتابة سبب تجاوز يوم الدوام',
    COOLDOWN: 'تم مسح هذا الطالب قبل قليل',
    NO_BALANCE: 'لا يوجد رصيد رحلات',
    INCONSISTENT_DAY: 'بيانات اليوم غير متسقة، يرجى مراجعة الإدارة',
    DAY_COMPLETE: 'تم استخدام رحلتي اليوم (ذهاب وعودة)',
    NETWORK: 'تعذر الاتصال بالخادم، حاول مرة أخرى',
  } as Record<string, string>,

  api: {
    UNAUTHORIZED: 'يجب تسجيل الدخول',
    FORBIDDEN: 'ليس لديك صلاحية لهذا الإجراء',
    NOT_FOUND: 'العنصر غير موجود',
    VALIDATION: 'البيانات المدخلة غير صالحة',
    INTERNAL: 'حدث خطأ غير متوقع في الخادم',
    PHOTO_LOCKED: 'تم رفع الصورة مسبقاً ولا يمكن تغييرها',
    PHOTO_TYPE: 'نوع الصورة غير مدعوم، يرجى استخدام JPEG أو PNG أو WEBP',
    PHOTO_SIZE: 'حجم الصورة أكبر من المسموح',
    PHOTO_INVALID: 'تعذرت قراءة الصورة، يرجى اختيار صورة أخرى',
    NOT_STUDENT: 'هذا الحساب ليس حساب طالب',
    FILE_REQUIRED: 'يرجى اختيار ملف',
    FILE_TYPE: 'يجب أن يكون الملف بصيغة Excel (.xlsx)',
    FILE_EMPTY: 'الملف لا يحتوي على بيانات',
    MISSING_COLUMN: 'تعذر العثور على العمود المطلوب: ',
    LOGIN_CODE_TAKEN: 'رمز الدخول مستخدم مسبقاً',
    LOGIN_CODE_RESERVED: 'رمز الدخول يشبه رقم نقل طالب أو دكتور (مثل SHB0003)، اختر رمزاً آخر مثل SUP-03',
    PASSWORD_WEAK: 'كلمة المرور لا تحقق الشروط المطلوبة',
    PASSWORD_MISMATCH: 'كلمتا المرور غير متطابقتين',
    STUDENT_EXISTS: 'يوجد طالب بنفس الرقم الجامعي في هذه الجامعة',
    PROVISION_FAILED: 'تعذر إنشاء حساب الطالب',
    PUSH_DISABLED: 'الإشعارات الفورية غير مفعلة على الخادم',
    NO_RECIPIENTS: 'لا يوجد مستلمون لهذا الإشعار',
    UNIVERSITY_REQUIRED: 'يرجى اختيار الجامعة',
  } as Record<string, string>,

  import: {
    DUPLICATE_ROW: 'صف مكرر — تم الاعتماد على أحدث تسجيل',
    NAME_REQUIRED: 'الاسم فارغ',
    NAME_TOO_SHORT: 'يجب أن يتكون الاسم من كلمتين على الأقل',
    NAME_NOT_TRIPLE: 'الاسم ليس ثلاثياً',
    STUDENT_NO_INVALID: 'الرقم الجامعي غير صالح',
    PHONE_INVALID: 'رقم الهاتف غير صالح',
    NATIONAL_ID_INVALID: 'الرقم الوطني غير صالح (أرقام فقط، من 6 إلى 20 رقماً)',
    NATIONAL_ID_LENGTH: 'الرقم الوطني ليس من 11 رقماً (مسموح)',
    NATIONAL_ID_REQUIRED: 'الرقم الوطني فارغ (مطلوب، وهو كلمة المرور الأولية)',
    ASKED_AT_LOGIN: ' — سيُسأل عنه الطالب عند أول دخول',
    MISSING_ANSWERS: 'سيكمل الطالب عند أول دخول: ',
    FIELD_PHONE: 'الهاتف',
    FIELD_COLLEGE: 'الكلية',
    FIELD_DAYS: 'أيام الدوام',
    FIELD_SHIFT: 'بداية الدوام',
    PHONE_DUPLICATE: 'رقم الهاتف مكرر لدى طالب آخر (مسموح)',
    COLLEGE_REQUIRED: 'الكلية غير محددة',
    COLLEGE_NEW: 'كلية جديدة سيتم إنشاؤها: ',
    WORK_DAYS_EMPTY: 'لم يتم تحديد أيام الدوام',
    WORK_DAYS_UNKNOWN: 'يوم دوام غير معروف: ',
    SHIFT_UNKNOWN: 'موعد بدء الدوام غير معروف: ',
    AREA_UNKNOWN: 'المنطقة غير موجودة في القائمة وستحتاج إلى ربط: ',
    AREA_OTHER_EMPTY: 'تم اختيار (أخرى) دون كتابة اسم المنطقة',
    PROVISION_FAILED: 'تعذر إنشاء حساب الطالب',
  },

  password: {
    minLength: (n: number) => `${n} أحرف على الأقل`,
    upper: 'حرف إنجليزي كبير واحد على الأقل',
    digit: 'رقم واحد على الأقل',
    match: 'تطابق كلمة المرور مع التأكيد',
  },

  notifications: {
    lowBalanceTitle: 'رصيد الرحلات منخفض',
    lowBalanceBody: (remaining: number) => `تبقى لديك ${remaining} رحلة هذا الأسبوع`,
    expiringTitle: 'اشتراكك على وشك الانتهاء',
    expiringBody: (date: string) => `ينتهي اشتراكك بتاريخ ${date}`,
    scheduleTitle: 'تغيير في مواعيد الرحلات',
    testTitle: 'إشعار تجريبي',
    testBody: 'تم تفعيل الإشعارات على هذا الجهاز بنجاح',
  },

  phoneCountry: {
    SY: 'سوريا',
  } as Record<string, string>,
} as const;

export type ArShared = typeof arShared;
