import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    const method = Array.prototype[key] as any
    instrumentations[key] = function(this: unknown[], ...args: unknown[]) {
      // 如果target对象中指定了getter，receiver则为getter调用时的this值
      // 所以这里的this指向receiver，即proxy实例，toRaw为了取得原始实例
      const arr = toRaw(this)
      // 对数组的每个值进行track操作，搜集依赖
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      // 参数有可能是响应式的，函数执行后返回值为-1或false，那就用参数的原始值再试一遍
      const res = method.apply(arr, args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return method.apply(arr, args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    const method = Array.prototype[key] as any
    instrumentations[key] = function(this: unknown[], ...args: unknown[]) {
      pauseTracking()
      const res = method.apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

/**
 * @description: 用于拦截对象的读取属性操作
 * @param {isReadonly} 是否只读
 * @param {shallow} 是否浅观察
 */
function createGetter(isReadonly = false, shallow = false) {
  /**
   * @description:
   * @param {target} 目标对象
   * @param {key} 属性名
   * @param {receiver} Proxy或者继承Proxy的对象
   */
  return function get(target: Target, key: string | symbol, receiver: object) {
    // target是否是响应式
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
      // target是否是只读
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
      // 如果key是raw 并且 是已经存储在响应式处理后的map记录中就直接返回对象
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
            ? shallowReactiveMap
            : reactiveMap
        ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)

    // 如果target是数组并且 key属于一些数组的原始方法，即触发这些操作
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    /* 
      不管proxy怎么修改默认行为，你总可以在Reflect上获取默认行为
      如果不用Reflect来获取，在监听数组时可以会有某些地方会出错
    */
    const res = Reflect.get(target, key, receiver)

    // 如果key是symbol的内置方法，或者是原型对象，就直接返回结果
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 只读对象不收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅层响应立即返回，不递归调用reactive()
    if (shallow) {
      return res
    }

    // 如果是ref对象，则返回真正的值，即ref.value 数组与整数键除外
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 由于proxy只能代理一层，所以target[key]的值如果是对象，则继续对其进行代理
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object, // 目标对象
    key: string | symbol, // 设置的属性
    value: unknown, // 新属性值
    receiver: object // 最初被调用的对象
  ): boolean {
    let oldValue = (target as any)[key]
    if (!shallow) {
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      // 如果原来的值是ref，但新的值不是，则将新的值赋给oldValue.value
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 如果target 没有 key，就代表是新增操作，需要触发依赖
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 如果新旧值不相等，才触发依赖
        // 什么时候会有新旧值相等的情况？例如监听一个数组，执行push操作，会触发多次setter
        // 第一次setter是新加的值 第二次是由于新加的值导致length改变
        // 但由于length也是自身属性，所以value === oldValue
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

/**
 * @description: 用于拦截对象的删除属性操作
 * @param {target} 目标对象
 * @param {key} 键值
 * @return {Boolean}
 */
function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key) // 检查一个对象是否包含当前key
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  // 如果删除结果为true，并且target拥有这个key就触发依赖
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

/**
 * @description: 检查一个对象是否拥有某个属性
 * @param {target} 目标对象
 * @param {key} 键值
 * @return {Boolean}
 */
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}
/* 
 * 返回一个由目标对象自身的属性键组成的数组
 */
function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
