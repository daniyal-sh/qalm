/** Origin of every app mutation: `doc.transact(fn, LOCAL_ORIGIN)`. Undo tracks only this origin. */
export const LOCAL_ORIGIN: unique symbol = Symbol('qalm.local');
