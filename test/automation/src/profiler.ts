/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Protocol } from 'playwright-core/types/protocol';
const { decode_bytes } = require('@vscode/v8-heap-parser');
import { Code } from './code';
import { PlaywrightDriver } from './playwrightDriver';

export class Profiler {
	constructor(private readonly code: Code) {
	}

	async checkObjectLeaks(classNames: string | string[], fn: () => Promise<void>): Promise<void> {
		await this.code.driver.startCDP();

		const countsBefore: { [key: string]: number } = {};
		const instancesBefore = await getInstances(this.code.driver);
		const classNamesArray = Array.isArray(classNames) ? classNames : [classNames];
		for (const className of classNamesArray) {
			const matchedInstances = instancesBefore.value.find(e => e.name !== undefined && e.name === className);
			if (!matchedInstances) {
				throw new Error(`${className} not found`);
			}
			countsBefore[className] = matchedInstances.count;
		}

		await instancesBefore.dispose();

		await fn();

		const instancesAfter = await getInstances(this.code.driver);
		const leaks: string[] = [];
		for (const className of classNamesArray) {
			const matchedInstancesAfter = instancesAfter.value.find(e => e.name !== undefined && e.name === className);
			if (!matchedInstancesAfter) {
				throw new Error(`${className} not found`);
			}

			const countAfter = matchedInstancesAfter.count;
			if (countAfter !== countsBefore[className]) {
				leaks.push(`Leaked ${countAfter - countsBefore[className]} ${className}`);
			}
		}

		await instancesAfter.dispose();

		if (leaks.length > 0) {
			throw new Error(leaks.join('\n'));
		}
	}

	async checkHeapLeaks(classNames: string | string[], fn: () => Promise<void>): Promise<void> {
		await this.code.driver.startCDP();
		await fn();

		const heapSnapshotAfter = await this.code.driver.takeHeapSnapshot();
		const buff = Buffer.from(heapSnapshotAfter);
		const graph = await decode_bytes(buff);
		const counts: number[] = Array.from(graph.get_class_counts(classNames));
		const leaks: string[] = [];
		for (let i = 0; i < classNames.length; i++) {
			if (counts[i] > 0) {
				leaks.push(`Leaked ${counts[i]} ${classNames[i]}`);
			}
		}

		if (leaks.length > 0) {
			throw new Error(leaks.join('\n'));
		}
	}
}

function generateUuid() {
	// use `randomValues` if possible
	function getRandomValues(bucket: Uint8Array): Uint8Array {
		for (let i = 0; i < bucket.length; i++) {
			bucket[i] = Math.floor(Math.random() * 256);
		}
		return bucket;
	}

	// prep-work
	const _data = new Uint8Array(16);
	const _hex: string[] = [];
	for (let i = 0; i < 256; i++) {
		_hex.push(i.toString(16).padStart(2, '0'));
	}

	// get data
	getRandomValues(_data);

	// set version bits
	_data[6] = (_data[6] & 0x0f) | 0x40;
	_data[8] = (_data[8] & 0x3f) | 0x80;

	// print as string
	let i = 0;
	let result = '';
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += '-';
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += '-';
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += '-';
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += '-';
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	result += _hex[_data[i++]];
	return result;
}



/*---------------------------------------------------------------------------------------------
 *  The MIT License (MIT)
 *  Copyright (c) 2023-present, Simon Siefke
 *
 *  This code is derived from https://github.com/SimonSiefke/vscode-memory-leak-finder
 *--------------------------------------------------------------------------------------------*/

const getInstances = async (driver: PlaywrightDriver): Promise<{ value: Array<{ name: string; count: number }>; dispose: () => Promise<void> }> => {
	await driver.collectGarbage();
	const objectGroup = `og:${generateUuid()}`;
	const prototypeDescriptor = await driver.evaluate({
		expression: 'Object.prototype',
		returnByValue: false,
		objectGroup,
	});
	const objects = await driver.queryObjects({
		prototypeObjectId: prototypeDescriptor.result.objectId!,
		objectGroup,
	});
	const fnResult1 = await driver.callFunctionOn({
		functionDeclaration: `function(){
	const objects = this

	const nativeConstructors = [
		Object,
		Array,
		Function,
		Set,
		Map,
		WeakMap,
		WeakSet,
		RegExp,
		Node,
		HTMLScriptElement,
		DOMRectReadOnly,
		DOMRect,
		HTMLHtmlElement,
		Node,
		DOMTokenList,
		HTMLUListElement,
		HTMLStyleElement,
		HTMLDivElement,
		HTMLCollection,
		FocusEvent,
		Promise,
		HTMLLinkElement,
		HTMLLIElement,
		HTMLAnchorElement,
		HTMLSpanElement,
		ArrayBuffer,
		Uint16Array,
		HTMLLabelElement,
		TrustedTypePolicy,
		Uint8Array,
		Uint32Array,
		HTMLHeadingElement,
		MediaQueryList,
		HTMLDocument,
		TextDecoder,
		TextEncoder,
		HTMLInputElement,
		HTMLCanvasElement,
		HTMLIFrameElement,
		Int32Array,
		CSSStyleDeclaration
	]

	const isNativeConstructor = object => {
		return nativeConstructors.includes(object.constructor) ||
			object.constructor.name === 'AsyncFunction' ||
			object.constructor.name === 'GeneratorFunction' ||
			object.constructor.name === 'AsyncGeneratorFunction'
	}

	const isInstance = (object) => {
		return object && !isNativeConstructor(object)
	}

	const instances = objects.filter(isInstance)
	return instances
}`,
		objectId: objects.objects.objectId,
		returnByValue: false,
		objectGroup,
	});

	const fnResult2 = await getInstanceCountMap(driver, objectGroup, fnResult1.result);
	const fnResult3 = await getInstanceCountArray(driver, objectGroup, fnResult2.result);
	return {
		value: fnResult3.result.value,
		dispose: async () => {
			// release object group
			await driver.releaseObjectGroup({ objectGroup: objectGroup });
		}
	};
};

const getInstanceCountMap = async (driver: PlaywrightDriver, objectGroup: string, objects: Protocol.Runtime.RemoteObject) => {
	const fnResult1 = await driver.callFunctionOn({
		functionDeclaration: `function(){
	const instances = this

	const map = new Map()

	for(const instance of instances){
		if(map.has(instance.constructor)){
			map.set(instance.constructor, map.get(instance.constructor) + 1)
		} else {
			map.set(instance.constructor, 1)
		}
	}
	return map
}`,
		objectId: objects.objectId,
		returnByValue: false,
		objectGroup,
	});

	return fnResult1;
};

const getInstanceCountArray = async (driver: PlaywrightDriver, objectGroup: string, map: Protocol.Runtime.RemoteObject) => {
	const fnResult1 = await driver.callFunctionOn({
		functionDeclaration: `function(){
	const map = this
	const array = []

	for(const [instanceConstructor, count] of map.entries()){
		array.push({
			name: instanceConstructor.name,
			count,
		})
	}

	return array
}`,
		objectId: map.objectId,
		returnByValue: true,
		objectGroup,
	});
	return fnResult1;
};
