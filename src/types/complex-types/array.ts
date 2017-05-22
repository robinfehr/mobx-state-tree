import { observable, IObservableArray, IArrayWillChange, IArrayWillSplice, IArrayChange, IArraySplice, action, intercept, observe } from "mobx"
import {
    getMSTAdministration,
    IJsonPatch,
    maybeMST,
    MSTAdministration,
    valueToSnapshot
} from "../../core"
import { addHiddenFinalProp, identity, nothing } from "../../utils"
import { IType, IComplexType, TypeFlags, isType } from "../type"
import { IContext, IValidationResult, typeCheckFailure, flattenTypeErrors, getContextForPath } from "../type-checker"
import { ComplexType } from "./complex-type"

export function arrayToString(this: IObservableArray<any>) {
    return `${getMSTAdministration(this)}(${this.length} items)`
}

export class ArrayType<S, T> extends ComplexType<S[], IObservableArray<T>> {
    isArrayFactory = true
    subType: IType<any, any>
    readonly flags = TypeFlags.Array

    constructor(name: string, subType: IType<any, any>) {
        super(name)
        this.subType = subType
    }

    describe() {
        return this.subType.describe() + "[]"
    }

    createNewInstance() {
        const array = observable.shallowArray()
        addHiddenFinalProp(array, "toString", arrayToString)
        return array
    }

    finalizeNewInstance(instance: IObservableArray<any>, snapshot: any) {
        intercept(instance, change => this.willChange(change) as any)
        observe(instance, this.didChange.bind(null, (this as IType<any, any>).meta))
        getMSTAdministration(instance).applySnapshot(snapshot)
    }

    getChildMSTs(node: MSTAdministration): [string, MSTAdministration][] {
        const target = node.target as IObservableArray<any>
        const res: [string, MSTAdministration][] = []
        target.forEach((value, index) => {
            maybeMST(value, childNode => { res.push(["" + index, childNode])})
        })
        return res
    }

    getChildMST(node: MSTAdministration, key: string): MSTAdministration | null {
        const target = node.target as IObservableArray<any>
        const index = parseInt(key, 10)
        if (index < target.length)
            return maybeMST(target[index], identity, nothing)
        return null
    }

    willChange(change: IArrayWillChange<any> | IArrayWillSplice<any>): Object | null {
        const node = getMSTAdministration(change.object)
        node.assertWritable()

        switch (change.type) {
            case "update":
                if (change.newValue === change.object[change.index])
                    return null
                change.newValue = node.reconcileChildren(this.subType, [change.object[change.index]], [change.newValue], [change.index])[0]
                break
            case "splice":
                const {index, removedCount, added, object} = change
                change.added = node.reconcileChildren(
                    this.subType,
                    object.slice(index, index + removedCount),
                    added,
                    added.map((_, i) => index + i)
                )

                // update paths of remaining items
                for (let i = index + removedCount; i < object.length; i++) {
                    maybeMST(object[i], child => {
                        child.setParent(node, "" + (i + added.length - removedCount))
                    })
                }
                break
        }
        return change
    }

    serialize(node: MSTAdministration): any {
        const target = node.target as IObservableArray<any>
        return target.map(valueToSnapshot)
    }

    didChange(meta: Object, change: IArrayChange<any> | IArraySplice<any>): void {
        const node = getMSTAdministration(change.object)
        let patch : IJsonPatch = {
          op: "replace",
          path: ""
        }
        switch (change.type) {
            case "update":
                patch = {
                    op: "replace",
                    path: "" + change.index,
                    value: valueToSnapshot(change.newValue)
                }
                if (meta) patch.meta = meta
                return void node.emitPatch(patch, node)
            case "splice":
                for (let i = change.index + change.removedCount - 1; i >= change.index; i--)
                    patch = {
                        op: "remove",
                        path: "" + i
                    }
                    if (meta) patch.meta = meta
                    node.emitPatch(patch, node)
                for (let i = 0; i < change.addedCount; i++)
                    patch = {
                        op: "add",
                        path: "" + (change.index + i),
                        value: valueToSnapshot(change.added[i])
                    }
                    if (meta) patch.meta = meta
                    node.emitPatch(patch, node)
                return
        }
    }

    applyPatchLocally(node: MSTAdministration, subpath: string, patch: IJsonPatch): void {
        const target = node.target as IObservableArray<any>
        const index = subpath === "-" ? target.length : parseInt(subpath)
        switch (patch.op) {
            case "replace":
                target[index] = patch.value
                break
            case "add":
                target.splice(index, 0, patch.value)
                break
            case "remove":
                target.splice(index, 1)
                break
        }
    }

    @action applySnapshot(node: MSTAdministration, snapshot: any[]): void {
        node.pseudoAction(() => {
            const target = node.target as IObservableArray<any>
            target.replace(snapshot)
        })
    }

    getChildType(key: string): IType<any, any> {
        return this.subType
    }

    isValidSnapshot(value: any, context: IContext): IValidationResult {
        if (!Array.isArray(value)) {
            return typeCheckFailure(context, value)
        }

        return flattenTypeErrors(
            value.map(
                (item, index) => this.subType.validate(item, getContextForPath(context, "" + index, this.subType))
            )
        )
    }

    getDefaultSnapshot() {
        return []
    }

    removeChild(node: MSTAdministration, subpath: string) {
        node.target.splice(parseInt(subpath, 10), 1)
    }

    get identifierAttribute() {
        return null
    }
}

export function array<S, T>(subtype: IType<S, T>): IComplexType<S[], IObservableArray<T>> {
    return new ArrayType<S, T>(subtype.name + "[]", subtype)
}

export function isArrayFactory<S, T>(type: any): type is IComplexType<S[], IObservableArray<T>> {
    return isType(type) && ((type as IType<any, any>).flags & TypeFlags.Array) > 0
}
