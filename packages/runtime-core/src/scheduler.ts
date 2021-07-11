import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray } from '@vue/shared'
import { ComponentPublicInstance } from './componentPublicInstance'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'
import { ReactiveEffect } from '@vue/reactivity'

export interface SchedulerJob extends Function, Partial<ReactiveEffect> {
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerCb = Function & { id?: number }
export type SchedulerCbs = SchedulerCb | SchedulerCb[]

let isFlushing = false // 任务队列是否正在排空
let isFlushPending = false // 微任务已创建，任务队列等待排空

const queue: SchedulerJob[] = [] // 主任务队列，用于存储更新任务
let flushIndex = 0 // 当前正在执行的任务在主任务队列中的索引

/**
 * 框架运行过程中产生的前置回调任务，比如一些特定的生命周期
 * 这些回调任务是在主任务队列queue开始排空前批量排空执行的
 */
const pendingPreFlushCbs: SchedulerCb[] = []
// 当前激活的前置回调任务
let activePreFlushCbs: SchedulerCb[] | null = null
// 当前前置回调任务在队列中的索引
let preFlushIndex = 0

/**
 * 框架运行过程中产生的后置回调任务，比如一些特定的生命周期
 * 这些回调任务是在主任务队列queue排空后批量排空执行的
 */
const pendingPostFlushCbs: SchedulerCb[] = []
// 当前激活的后置回调任务
let activePostFlushCbs: SchedulerCb[] | null = null
// 当前后置回调任务在队列中的索引
let postFlushIndex = 0

// 微任务创建器
const resolvedPromise: Promise<any> = Promise.resolve()
// 当前微任务promise
let currentFlushPromise: Promise<void> | null = null

let currentPreFlushParentJob: SchedulerJob | null = null

const RECURSION_LIMIT = 100 // 同一个任务递归执行的上限次数
type CountMap = Map<SchedulerJob | SchedulerCb, number> // 记录每个任务执行的次数

export function nextTick(
  this: ComponentPublicInstance | void,
  fn?: () => void
): Promise<void> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
// 二分查找任务在队列中的位置
function findInsertionIndex(job: SchedulerJob) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length
  const jobId = getId(job)

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < jobId ? (start = middle + 1) : (end = middle)
  }

  return start
}

export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  /**
   * 主任务可入队逻辑
   * 1. 队列为空
   * 2. 正在清空队列(有正在执行的任务)且当前待入队任务是允许递归执行本身的，因此待入队任务和正在执行任务相同，但不能和后面待执行任务相同
   * 3. 其他清空下，由于不会出现任务自身递归执行的情况，因此待入队任务不能和当前正在执行任务以及后面待执行任务相同
   */
  if (
    (!queue.length ||
      !queue.includes(
        job,
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    job !== currentPreFlushParentJob
  ) {
    const pos = findInsertionIndex(job)
    // 满足入队条件，将主任务入队
    if (pos > -1) {
      queue.splice(pos, 0, job)
    } else {
      queue.push(job)
    }
    queueFlush()
  }
}

function queueFlush() {
  /**
   * 在微任务已创建或者正在执行微任务时禁止再次创建更多的微任务
   * 因为在主线程同步任务执行完后才会执行已创建的微任务，此时入队操作已完成，并且flushJobs会在一次微任务中会递归的将主任务队列全部清空，所以只需要一个微任务即可
   * 如果重复创建微任务会导致接下来的微任务执行时队列是空的，那么这个微任务时无意义的，因为它不能清队
   */
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    // 微任务创建成功，并记录当前微任务，作为nextTick创建自定义微任务的支点，也就是说，nextTick创建出来的微任务执行顺序紧跟在清队微任务后，保证自定义微任务执行时机的准确性
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

function queueCb(
  cb: SchedulerCbs,
  activeQueue: SchedulerCb[] | null,
  pendingQueue: SchedulerCb[],
  index: number
) {
  if (!isArray(cb)) {
    if (
      !activeQueue ||
      !activeQueue.includes(
        cb,
        (cb as SchedulerJob).allowRecurse ? index + 1 : index
      )
    ) {
      pendingQueue.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingQueue.push(...cb)
  }
  queueFlush()
}

export function queuePreFlushCb(cb: SchedulerCb) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}

export function queuePostFlushCb(cb: SchedulerCbs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

export function flushPreFlushCbs(
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  if (pendingPreFlushCbs.length) {
    currentPreFlushParentJob = parentJob
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)]
    pendingPreFlushCbs.length = 0
    if (__DEV__) {
      seen = seen || new Map()
    }
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }
      activePreFlushCbs[preFlushIndex]()
    }
    activePreFlushCbs = null
    preFlushIndex = 0
    currentPreFlushParentJob = null
    // recursively flush until it drains
    flushPreFlushCbs(seen, parentJob)
  }
}

export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob | SchedulerCb) =>
  job.id == null ? Infinity : job.id

/**
 * flushJobs执行顺序
 * 批量清空前置回调任务队列 > 清空主任务队列 > 批量清空后置回调任务队列
 */
function flushJobs(seen?: CountMap) {
  isFlushPending = false // 关闭微任务等待执行标识
  isFlushing = true // 开始微任务正在清空队列标识
  if (__DEV__) {
    seen = seen || new Map()
  }

  // 批量执行清空前置回调任务队列
  flushPreFlushCbs(seen)

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  /* 
    将主任务队列中的任务按照ID进行排序原因
      1. 组件更新是由父到子的，而更新任务是在数据源更新时触发的，trigger会执行effect中的scheduler，scheduler回调会把effect作为更新任务推入主任务队列，排序保证了更新任务是按照由父到子的顺序进行执行的
      2. 当一个组件父组件更新时执行卸载操作，任务排序确保了已卸载组件的更新会被跳过
  */
  queue.sort((a, b) => getId(a) - getId(b))

  try {
    // 遍历主任务队列，批量执行更新任务
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && checkRecursiveUpdates(seen!, job)) {
          continue
        }
        // 执行当前更新任务
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    // 当前队列任务执行完毕，重置当前任务索引
    flushIndex = 0
    // 清空主任务队列
    queue.length = 0

    // 主队列清空后执行后置回调任务
    flushPostFlushCbs(seen)

    isFlushing = false // 清队完成后重置状态
    currentFlushPromise = null // 清队完成后重置currentFlushPromise
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    /* 
      由于清队期间也有可能会有任务入队，因此会导致按照微任务开始执行时的队长度遍历清队，会导致无法彻底清干净，因此需要递归的清空队伍，保证一次清队，微任务中的所有任务都被全部清空
    */
    if (
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob | SchedulerCb) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = (fn as SchedulerJob).ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
