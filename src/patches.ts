import {get, each, isMap, isSet, has} from "./common"
import {Patch, ImmerState} from "./types"
import {SetState} from "./set"

export function generatePatches(
	state: ImmerState,
	basePath: (string | number)[],
	patches: Patch[],
	inversePatches: Patch[]
) {
	// TODO: use a proper switch here
	const generatePatchesFn = Array.isArray(state.base)
		? generateArrayPatches
		: isSet(state.base)
		? generateSetPatches
		: generatePatchesFromAssigned

	generatePatchesFn(state as any, basePath, patches, inversePatches)
}

function generateArrayPatches(
	state: any, // TODO: type properly with ImmerState
	basePath: (string | number)[],
	patches: Patch[],
	inversePatches: Patch[]
) {
	let {base, copy, assigned} = state

	// Reduce complexity by ensuring `base` is never longer.
	if (copy.length < base.length) {
		;[base, copy] = [copy, base]
		;[patches, inversePatches] = [inversePatches, patches]
	}

	const delta = copy.length - base.length

	// Find the first replaced index.
	let start = 0
	while (base[start] === copy[start] && start < base.length) {
		++start
	}

	// Find the last replaced index. Search from the end to optimize splice patches.
	let end = base.length
	while (end > start && base[end - 1] === copy[end + delta - 1]) {
		--end
	}

	// Process replaced indices.
	for (let i = start; i < end; ++i) {
		if (assigned[i] && copy[i] !== base[i]) {
			const path = basePath.concat([i])
			patches.push({
				op: "replace",
				path,
				value: copy[i]
			})
			inversePatches.push({
				op: "replace",
				path,
				value: base[i]
			})
		}
	}

	const replaceCount = patches.length

	// Process added indices.
	for (let i = end + delta - 1; i >= end; --i) {
		const path = basePath.concat([i])
		patches[replaceCount + i - end] = {
			op: "add",
			path,
			value: copy[i]
		}
		inversePatches.push({
			op: "remove",
			path
		})
	}
}

// This is used for both Map objects and normal objects.
function generatePatchesFromAssigned(
	state: any, // TODO: type properly with ImmerState
	basePath: (number | string)[],
	patches: Patch[],
	inversePatches: Patch[]
) {
	const {base, copy} = state
	if (state.assigned)
		each(state.assigned, (key, assignedValue) => {
			const origValue = get(base, key)
			const value = get(copy, key)
			const op = !assignedValue ? "remove" : has(base, key) ? "replace" : "add"
			if (origValue === value && op === "replace") return
			const path = basePath.concat(key as any)
			patches.push(op === "remove" ? {op, path} : {op, path, value})
			inversePatches.push(
				op === "add"
					? {op: "remove", path}
					: op === "remove"
					? {op: "add", path, value: origValue}
					: {op: "replace", path, value: origValue}
			)
		})
}

function generateSetPatches(
	state: SetState,
	basePath: (number | string)[],
	patches: Patch[],
	inversePatches: Patch[]
) {
	let {base, copy} = state

	let i = 0
	base.forEach(value => {
		if (!copy!.has(value)) {
			const path = basePath.concat([i])
			patches.push({
				op: "remove",
				path,
				value
			})
			inversePatches.unshift({
				op: "add",
				path,
				value
			})
		}
		i++
	})
	i = 0
	copy!.forEach(value => {
		if (!base.has(value)) {
			const path = basePath.concat([i])
			patches.push({
				op: "add",
				path,
				value
			})
			inversePatches.unshift({
				op: "remove",
				path,
				value
			})
		}
		i++
	})
}

export function applyPatches<T>(draft: T, patches: Patch[]): T {
	patches.forEach(patch => {
		const {path, op} = patch

		if (!path.length) throw new Error("Illegal state")

		let base = draft
		for (let i = 0; i < path.length - 1; i++) {
			base = get(base, path[i])
			if (!base || typeof base !== "object")
				throw new Error("Cannot apply patch, path doesn't resolve: " + path.join("/")) // prettier-ignore
		}

		const value = deepClone(patch.value) // used to clone patch to ensure original patch is not modified, see #411

		const key = path[path.length - 1]
		switch (op) {
			case "replace":
				if (isMap(base)) {
					base.set(key, value)
				} else if (isSet(base)) {
					throw new Error('Sets cannot have "replace" patches.')
				} else {
					// if value is an object, then it's assigned by reference
					// in the following add or remove ops, the value field inside the patch will also be modifyed
					// so we use value from the cloned patch
					base[key] = value
				}
				break
			case "add":
				if (isSet(base)) {
					base.delete(patch.value)
				}

				Array.isArray(base)
					? base.splice(key as any, 0, value)
					: isMap(base)
					? base.set(key, value)
					: isSet(base)
					? base.add(value)
					: (base[key] = value)
				break
			case "remove":
				Array.isArray(base)
					? base.splice(key as any, 1)
					: isMap(base)
					? base.delete(key)
					: isSet(base)
					? base.delete(patch.value)
					: delete base[key]
				break
			default:
				throw new Error("Unsupported patch operation: " + op)
		}
	})

	return draft
}

// TODO: optimize: this is quite a performance hit, can we detect intelligently when it is needed?
// E.g. auto-draft when new objects from outside are assigned and modified?
// (See failing test when deepClone just returns obj)
function deepClone(obj) {
	if (!obj || typeof obj !== "object") return obj
	if (Array.isArray(obj)) return obj.map(deepClone)
	if (isMap(obj))
		return new Map(Array.from(obj.entries()).map(([k, v]) => [k, deepClone(v)]))
	if (isSet(obj)) return new Set(Array.from(obj.values()).map(deepClone))
	const cloned = Object.create(Object.getPrototypeOf(obj))
	for (const key in obj) cloned[key] = deepClone(obj[key])
	return cloned
}