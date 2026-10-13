// ============================================================
//  SERVICE TYPE ki pehchaan — labour (JOB) lines se.   <<< YAHAN BADLO, phir server restart >>>
//
//  codes : labour ka CODE (PowerBI file me "SKU #")  — poora code, jaise '201001'
//  names : labour ke NAAM me ye shabd ho (poora shabd) — jaise 'REGULAR SERVICE'
//  UPAR SE NEECHE check hota hai — pehla jo match kare wahi type. (FSC upar, Paid, phir Accidental)
//  Kuch bhi match na ho -> 'General Repair'.  Labour line hi na mile -> '— (labour data nahi)'.
//  Accidental: yahan match na ho par invoice pe Insurance bhara ho, tab bhi Accidental.
// ============================================================
export const SERVICE_TYPES = [
  { type: 'FSC 1', codes: ['201001'], names: ['FSC I', 'FSC 1', 'FSC-1', 'FREE SERVICE I', 'FREE SERVICE 1'] },
  { type: 'FSC 2', codes: ['201002'], names: ['FSC II', 'FSC 2', 'FSC-2', 'FREE SERVICE II', 'FREE SERVICE 2'] },
  { type: 'FSC 3', codes: ['201003'], names: ['FSC III', 'FSC 3', 'FSC-3', 'FREE SERVICE III', 'FREE SERVICE 3'] },
  { type: 'FSC 4', codes: ['201004'], names: ['FSC IV', 'FSC 4', 'FSC-4', 'FREE SERVICE IV', 'FREE SERVICE 4'] },
  { type: 'FSC 5', codes: ['201005'], names: ['FSC V', 'FSC 5', 'FSC-5', 'FREE SERVICE V', 'FREE SERVICE 5'] },
  { type: 'Paid',  codes: ['202001'], names: ['REGULAR SERVICE', 'JOYRIDE', 'JOY RIDE', 'PAID SERVICE'] },
  { type: 'Accidental', codes: [], names: ['ACCIDENT', 'ACCIDENTAL'] },
];
export const DEFAULT_TYPE = 'General Repair';
