// Static configuration and seed data. No DOM access here.

export const SHIFT_NAMES = {
  morning: { en: 'Morning', ar: 'صباحي' },
  evening: { en: 'Evening', ar: 'مسائي' },
  saudi: { en: 'Saudi', ar: 'سعودي' }
};
export const SHIFT_TYPES = ['morning', 'saudi', 'evening'];
export const IMAGE_CATS = ['foodics', 'cash', 'network'];

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDmZl0xEqSfc7lJLeKTc-2R4INXb1d8xZ8',
  authDomain: 'rshaf-system.firebaseapp.com',
  projectId: 'rshaf-system',
  storageBucket: 'rshaf-system.firebasestorage.app',
  messagingSenderId: '332221663357',
  appId: '1:332221663357:web:0afb05e6cf8d34541c8914'
};
export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

// key -> Firestore collection + legacy localStorage key
export const COLLECTIONS = {
  shifts: { coll: 'dailyIncome_shifts', storage: 'rashf_shifts' },
  employees: { coll: 'dailyIncome_employees', storage: 'rashf_employees' },
  branches: { coll: 'dailyIncome_branches', storage: 'rashf_branches' },
  brands: { coll: 'dailyIncome_brands', storage: 'rashf_brands' },
  paymentMethods: { coll: 'dailyIncome_paymentMethods', storage: 'rashf_payment_methods' }
};
export const CONFIG_COLLECTIONS = ['employees', 'branches', 'brands', 'paymentMethods'];
// Both live under paths the existing security rules already allow ({doc=**}).
export const AUDIT_PATH = ['dailyIncome_settings', 'audit', 'log'];
export const SECURITY_DOC = ['dailyIncome_settings', 'security'];

// Legacy local login. Disabled automatically (on every device) the first time
// an accountant signs in with a real Firebase account.
export const LEGACY_ACCOUNTANT = { username: 'admin', password: 'admin' };

export const DEFAULT_SHIFT_WINDOW_DAYS = 45;

export const DEFAULT_BRANDS = [
  { id: 'rashf', nameAr: 'رشف', nameEn: 'Rashf' },
  { id: 'armeema', nameAr: 'أرميما', nameEn: 'Armeema' }
];

export const DEFAULT_PAYMENT_METHODS = [
  { id: 'mada', nameAr: 'مدى', nameEn: 'mada', order: 1, active: true, isCash: false, isCard: true },
  { id: 'cash', nameAr: 'كاش', nameEn: 'Cash', order: 2, active: true, isCash: true, isCard: false },
  { id: 'jahez', nameAr: 'جاهز', nameEn: 'Jahez', order: 3, active: true, isCash: false, isCard: false },
  { id: 'hunger', nameAr: 'هنقرستيشن', nameEn: 'Hunger Station', order: 4, active: true, isCash: false, isCard: false },
  { id: 'ninja', nameAr: 'نينجا', nameEn: 'Ninja', order: 5, active: true, isCash: false, isCard: false },
  { id: 'keeta', nameAr: 'كيتا', nameEn: 'Keeta', order: 6, active: true, isCash: false, isCard: false },
  { id: 'online', nameAr: 'أونلاين', nameEn: 'Order Online', order: 7, active: true, isCash: false, isCard: false }
];

const BRANCH_SEED = [
  ['بريدة الملك خالد', 'Buraydah King Khalid'],
  ['بريدة الملك سلمان', 'Buraydah King Salman'],
  ['بريدة البساتين', 'Buraydah Al-Basateen'],
  ['بريدة علي', 'Buraydah Ali'],
  ['رياض الخبراء', 'Riyadh Al-Khabra'],
  ['سلتي', 'Salate'],
  ['روسيل', 'Rosel'],
  ['البدائع', 'Al-Badaye'],
  ['عنيزة', 'Unayzah'],
  ['بريدة قرطبة', 'Buraydah Qurtubah'],
  ['البكيرية', 'Al-Bukayriyyah']
];
export const SEED_BRANCHES = BRANCH_SEED.map(([nameAr, nameEn], i) => ({
  id: 'b' + (1779450662340 + i), nameAr, nameEn, brand: 'rashf'
}));

// [nameAr, nameEn, branchIndex, shift] — same ids as the original seed.
const EMP_SEED = [
  ['بريدة الملك خالد مسائي-Pm', '', 0, 'evening'],
  ['بريدة الملك خالد صباحي -Am', '', 0, 'morning'],
  ['بريدة الملك سلمان صباحي', '', 1, 'morning'],
  ['بريدة الملك سلمان مسائي', '', 1, 'evening'],
  ['بريدة البساتين مسائي', 'Bur.pm.B', 2, 'evening'],
  ['بريدة البساتين صباحي', 'Bur.am.B', 2, 'morning'],
  ['بريدة علي صباحي', 'Bur_Ali  Am', 3, 'morning'],
  ['بريدة علي مسائي', 'Bur_Ali  pm nightshipt', 3, 'evening'],
  ['رياض الخبراء مسائي', 'Pm Riyad alkhabra', 4, 'evening'],
  ['رياض الخبراء صباحي', 'Am Riyad alkhabra', 4, 'morning'],
  ['سلتي مسائي', 'Salate pm', 5, 'evening'],
  ['سلتي صباحي', 'Salate am', 5, 'morning'],
  ['روسيل مسائي', 'Rosel pm', 6, 'evening'],
  ['روسيل صباحي', 'Rosel am', 6, 'morning'],
  ['البدائع مسائي', 'badaaya pm', 7, 'evening'],
  ['البدائع صباحي', 'badaaya am', 7, 'morning'],
  ['عنيزة مسائي', 'uneza pm', 8, 'evening'],
  ['عنيزة صباحي', 'uneza am', 8, 'morning'],
  ['بريدة قرطبة مسائي', 'bureda pm night', 9, 'evening'],
  ['بريدة قرطبة صباحي', 'bureda am', 9, 'morning'],
  ['البكيرية مسائي', 'bk pm', 10, 'evening'],
  ['البكيرية صباحي', 'bk am', 10, 'morning']
];
export const SEED_EMPLOYEES = EMP_SEED.map(([nameAr, nameEn, b, shift], i) => ({
  id: 'e' + (1779450662440 + i), nameAr, nameEn, pin: '', brand: 'rashf',
  branchId: SEED_BRANCHES[b].id, shift
}));

// Fallback only, used when Google's model list can't be fetched. The real list
// comes from the API at runtime (ocr.listModels), so retired models drop out by themselves.
export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
