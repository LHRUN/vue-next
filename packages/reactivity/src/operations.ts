// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export const enum TrackOpTypes {
  GET = 'get', // get操作
  HAS = 'has', // has 操作
  ITERATE = 'iterate' // ownKeys操作
}

export const enum TriggerOpTypes {
  SET = 'set', // 设置操作
  ADD = 'add', // 新增操作
  DELETE = 'delete', // 删除操作
  CLEAR = 'clear' // 用于Map和Set的clear操作
}
