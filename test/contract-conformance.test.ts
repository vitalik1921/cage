import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkLinking, contract, data, designProject, mdx, writeFile } from "./helpers.ts";
import { runCli } from "../src/main.ts";

/** @tests Cli
 * @covers exact-surface exact-signatures */
test("exact public contracts on TypeScript 5 and 6: members, static sides, signatures and aliases", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const sources: Record<string, string> = {
      Exact: 'export class Exact { async run(id:string):Promise<string>{return id} }',
      Extra: 'export class Extra { async run(id:string):Promise<string>{return id} extra():void{} }',
      Field: 'export class Field { extra=1; async run(id:string):Promise<string>{return id} }',
      Constructor: 'export class Constructor { constructor(public extra:number){} async run(id:string):Promise<string>{return id} }',
      Static: 'export class Static { static extra():void{} async run(id:string):Promise<string>{return id} }',
      Inherited: 'export class Inherited extends Base { async run(id:string):Promise<string>{return id} }',
      Helpers: 'export class Helpers { #value=""; private helper():void{} protected other():void{} async run(id:string):Promise<string>{return id+this.#value} }',
      Fewer: 'export class Fewer { async run():Promise<string>{return ""} }',
      Optional: 'export class Optional { async run(id?:string):Promise<string>{return id??""} }',
      Added: 'export class Added { async run(id:string,extra?:number):Promise<string>{return id+extra} }',
      Narrow: 'export class Narrow { async run(id:"only"):Promise<string>{return id} }',
      Result: 'export class Result { async run(id:string):Promise<"only">{return "only"} }',
      Alias: 'export class Alias { async run(renamed:Text):Promise<Text>{return renamed} }',
      Any: 'export const Any:any={};',
      Unknown: 'export const Unknown:unknown={};',
      Object: 'export const Object={run:async(id:string):Promise<string>=>id,extra:1};',
      Missing: 'export class Missing {}',
    };
    // One contract per case, all of the same shape: each comparison is independent.
    const root = designProject(t, { m: mdx(...Object.keys(sources).map(name => contract(`${name}Action`, "run(id: string): Promise<string>;"))) });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    const header = 'type Text=string; class Base { extra():void{} }\n';
    for (const [name, source] of Object.entries(sources)) writeFile(root, `src/m/${name}.ts`, `${header}/** @implements ${name}Action */\n${source}`);
    const result = checkLinking(root);
    assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    for (const name of ["Exact", "Helpers", "Alias"]) assert.equal(result.linking.implementations.find(i => i.name === name)?.compatible, true, compiler+name);
    for (const name of Object.keys(sources).filter(n => !["Exact", "Helpers", "Alias"].includes(n))) assert.equal(result.linking.implementations.find(i => i.name === name)?.compatible, false, compiler+name);
    assert.ok(result.errors.some(d => d.code === "E_CONTRACT_EXTRA_MEMBER" && d.message.includes("Static static.extra")));
    assert.ok(result.errors.some(d => d.code === "E_CONTRACT_UNCHECKABLE"));
    let stdout="",stderr="";
    assert.equal(runCli(["check","--root",root],{cwd:root,stdout:x=>{stdout+=x},stderr:x=>{stderr+=x}}),1);
    assert.match(stdout,/E_CONTRACT_EXTRA_MEMBER/);
    assert.equal(runCli(["gate","--root",root],{cwd:root,stdout:()=>{},stderr:x=>{stderr+=x}}),2);
    assert.match(stderr,/E_CONTRACT_EXTRA_MEMBER/);
  }
});

/** @tests Cli
 * @covers exact-surface exact-signatures */
test("one contract inherits fields and methods; optional members and separate statics are checkable", (t) => {
  const root = designProject(t, { m: mdx(data("Read", "{get(): string; readonly name: string; optional?(): void;}"), data("Write", "{put(value: string): void;}"), contract("Store extends Read, Write", ""), contract("Factory", "create(): string;")) }, {
    "src/m/impl.ts": '/** @implements Store\n * @implements-static Factory */\nexport class Service { readonly name: string="ok"; get():string{return "ok"} put(value:string):void{} optional?():void; static create():string{return "ok"} }',
  });
  assert.deepEqual(checkLinking(root).errors, []);
  writeFile(root,"src/m/impl.ts",'/** @implements-static Factory */\nexport class Service { static create():string{return "ok"} }');
  const errors=checkLinking(root).errors;
  assert.deepEqual(errors.map(e=>e.code),["E_IMPLEMENTATION_MISSING"]);
});

/** @tests Cli
 * @covers exact-signatures */
test("signature comparison rejects nested API drift, readonly differences, optional omissions and rest changes", (t) => {
  const cases = [
    { name:"readonly", want:"readonly size: number;", have:"size:number=0;" },
    { name:"optional", want:"size?: number;", have:"size:number=0;" },
    { name:"omitted", want:"size?: number;", have:"" },
    { name:"rest", want:"run(...ids: string[]): void;", have:"run(ids:string[]):void{}" },
    { name:"nested", want:"run(): { name: string };", have:'run():{name:string;extra:number}{return {name:"",extra:1}}' },
    { name:"callback", want:"run(fn: (id:string)=>void): void;", have:"run(fn: ()=>void):void{}" },
    { name:"any", want:"run(id:string):void;", have:"run(id:any):void{}" },
  ];
  for(const c of cases){const root=designProject(t,{m:mdx(contract("Port",c.want))},{"src/m/impl.ts":'/** @implements Port */\nexport class Service {'+c.have+'}'});assert.ok(checkLinking(root).errors.length,c.name);}
});

/** @tests Cli
 * @covers exact-signatures */
test("equivalent aliases, reordered union/intersection members and recursive data preserve conformance", (t) => {
  const root=designProject(t,{m:mdx('/** @data\n * @description Recursive node */\nexport interface Node { name:string; next?:Node; }',contract("Port","run(node:Node, mode: 'a'|'b'): Promise<Node[]>;"))},{"src/m/impl.ts":'type N={name:string}&{next?:N};\n/** @implements Port */\nexport class Service { async run(renamed:N, mode:"b"|"a"):Promise<N[]>{return [renamed]} }'});
  assert.deepEqual(checkLinking(root).errors,[]);
});

/** @tests Cli
 * @covers exact-surface exact-signatures */
test("readonly mapped types and const assertions retain their public modifiers", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const cases = [
      ["ConstGood", "Read", 'export const ConstGood = {size: 1 as number} as const;', true],
      ["ConstBad", "Write", 'export const ConstBad = {size: 1 as number} as const;', false],
      ["SpreadBad", "Write", 'const source={size:1};\n/** @implements SpreadBadWrite */\nexport const SpreadBad={...source} as const;', false],
      ["InheritedBad", "Write", 'const Base=class {size:number=1} as new()=>Readonly<{size:number}>;\n/** @implements InheritedBadWrite */\nexport class InheritedBad extends Base {}', false],
      ["MappedGood", "Read", 'export const MappedGood: Readonly<{size: number}> = {size: 1};', true],
      ["MappedBad", "Write", 'export const MappedBad: Readonly<{size: number}> = {size: 1};', false],
      ["Getter", "Read", 'export class Getter { get size():number {return 1} }', true],
    ] as const;
    const shapes = { Read: "readonly size: number;", Write: "size: number;" };
    const root = designProject(t, { m: mdx(...cases.map(([name, shape]) => contract(`${name}${shape}`, shapes[shape]))) });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    for (const [name, shape, code] of cases) writeFile(root, `src/m/${name}.ts`, code.includes("/** @implements") ? code : `/** @implements ${name}${shape} */\n${code}`);
    const result = checkLinking(root);
    for (const [name, , , compatible] of cases) assert.equal(result.linking.implementations.find(i => i.name === name)?.compatible, compatible, compiler + name);
  }
});

/** @tests Cli
 * @covers exact-surface exact-signatures */
test("opaque and open surfaces fail; equivalent public data with private state and generic callbacks pass", (t) => {
  const root = designProject(t, { m: mdx(contract("Action", 'run(): void;'), contract("UnionAction", 'run(): void;'), contract("Data", 'get(): {name: string};'), contract("Map", 'map: <T>(value:T) => T;')) }, {
    "src/m/open.ts": '/** @implements Action */\nexport const open: {run():void; [key:string]:unknown}={run(){}};',
    "src/m/union.ts": '/** @implements UnionAction */\nexport const union: {run():void; a?:number}|{run():void; b?:number}={run(){}};',
    "src/m/data.ts": 'class Row {private hidden=0;name:string="x"}\n/** @implements Data */\nexport class Data {get(): Row {return new Row()}}',
    "src/m/map.ts": '/** @implements Map */\nexport const map={map:<U>(renamed:U):U=>renamed};',
  });
  const result = checkLinking(root);
  for (const name of ["open", "union"]) assert.ok(result.errors.some(d => d.code === "E_CONTRACT_UNCHECKABLE" && d.message.startsWith(name)), name);
  for (const name of ["Data", "map"]) assert.equal(result.linking.implementations.find(i => i.name === name)?.compatible, true, name);
});

/** @tests Cli
 * @covers exact-surface */
test("static tags bind only to classes and are visible in the linked surface", (t) => {
  const root = designProject(t, { m: mdx(contract("Factory", "create():string;")) }, {
    "src/m/impl.ts": '/** @implements-static Factory */\nexport class Factory {private static helper():void{} static create():string{return "ok"}}',
  });
  const result = checkLinking(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.linking.implementations[0].surface, "static");
  writeFile(root, "src/m/bad.ts", '/** @implements-static Factory */\nexport const bad={create:():string=>"ok"};');
  assert.ok(checkLinking(root).errors.some(d => d.code === "E_TAG_LOCATION" && d.message.includes("@implements-static")));
});

/** @tests Cli
 * @covers exact-signatures */
test("expanding recursive generics compare their declarations and arguments without unfolding forever", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root = designProject(t, { m: mdx(data("Tree<T>", "{value:T; next?:Tree<T[]>}"), contract("Reader", "read():Tree<string>;")) }, {
      "src/m/impl.ts": 'interface Branch<T>{value:T;next?:Branch<T[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {value:""}}}',
    });
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve("node_modules",compiler),path.join(root,"node_modules/typescript"),"dir");
    assert.deepEqual(checkLinking(root).errors, [], compiler);
    writeFile(root,"src/m/impl.ts",'interface Branch<T>{value:T;next?:Branch<number[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {value:""}}}');
    assert.ok(checkLinking(root).errors.some(d => d.code === "E_TYPE_MISMATCH" || d.code === "E_CONTRACT_SIGNATURE"), compiler);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("unbounded generic expansion fails explicitly and does not poison following comparisons", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root = designProject(t, { m: mdx(data("Tree", "{value:string;next?:Tree}"), contract("Reader", "read():Tree;"), contract("Callable", "():Tree;"), contract("SimpleReader", "read():Tree;"), contract("SimpleCallable", "():Tree;")) }, {
      "src/m/a.ts": 'interface Branch<T>{value:T extends string ? string : string;next?:Branch<T[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {value:""}}}\n/** @implements Callable */\nexport function read():Branch<string>{return {value:""}}',
      "src/m/z.ts": 'type Plain={value:string;next?:Plain};\n/** @implements SimpleReader */\nexport class Simple {read():Plain{return {value:""}}}\n/** @implements SimpleCallable */\nexport function simple():Plain{return {value:""}}',
    });
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve("node_modules",compiler),path.join(root,"node_modules/typescript"),"dir");
    const result=checkLinking(root);
    assert.equal(result.errors.filter(d => d.code === "E_CONTRACT_UNCHECKABLE").length, 2, compiler);
    assert.ok(result.errors.every(d => d.message.includes("comparison limit")), compiler);
    for (const name of ["Simple", "simple"]) assert.equal(result.linking.implementations.find(i => i.name === name)?.compatible,true,compiler+name);
  }
});

/** @tests Cli
 * @covers exact-surface exact-signatures */
test("intersection modifiers, setter inputs and resolved generic aliases match the public contract on TS5/TS6", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const cases = [
      ["AddedReadonly", "Mutable", 'get():Readonly<{size:number}>&{name:string}{return {size:1,name:""}}', false],
      ["RemovedReadonly", "Frozen", 'get():Mutable<{readonly size:number}>&{name:string}{return {size:1,name:""}}', false],
      ["SameReadonly", "Frozen", 'get():Readonly<{size:number}>&{name:string}{return {size:1,name:""}}', true],
      ["SameMutable", "Mutable", 'get():Mutable<{readonly size:number}>&{name:string}{return {size:1,name:""}}', true],
      ["Mixed", "Value", 'get value():string{return ""} set value(x:number){}', false],
      ["NarrowWrite", "Value", 'get value():string{return ""} set value(x:"only"){}', false],
      ["WideWrite", "Value", 'get value():string{return ""} set value(x:string|number){}', false],
      ["SameWrite", "Value", 'get value():string{return ""} set value(x:string){}', true],
      ["NestedWrite", "Nested", 'get(){return new BadValue()}', false],
      ["GenericWrite", "Nested", 'get():Box<string>{return new Box<string>()}', true],
      ["GenericBadWrite", "Nested", 'get():BadBox<string>{return new BadBox<string>()}', false],
      ["Swapped", "Pairs", 'get():Other<number,string>{return {a:"",b:1}}', true],
      ["Phantom", "Phantoms", 'get():OtherPhantom<number>{return {value:""}}', true],
    ] as const;
    const header = 'type Mutable<T>={-readonly[P in keyof T]:T[P]}; type Other<B,A>={a:A;b:B}; type OtherPhantom<T>={value:string}; class BadValue {get value():string{return ""} set value(x:number){}} class Box<T>{get value():T{throw 1} set value(x:T){}} class BadBox<T>{get value():T{throw 1} set value(x:T[]){}}\n';
    const shapes = {
      Mutable: "get():{size:number;name:string};", Frozen: "get():{readonly size:number;name:string};",
      Value: "value:string;", ReadonlyValue: "readonly value:string;", Nested: "get():{value:string};",
      Pairs: "get():Pair<string,number>;", Phantoms: "get():Phantom<string>;",
    };
    // One contract per case, named after the case and shaped as its kind: each comparison is independent.
    const root = designProject(t, { m: mdx(
      data("Pair<A,B>", "{a:A; b:B}"), data("Phantom<T>", "{value:string}"),
      ...cases.map(([name, shape]) => contract(`${name}${shape}`, shapes[shape])),
      contract("WritableValue", shapes.Value), contract("ReadonlyValue", shapes.ReadonlyValue),
    ) });
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve("node_modules",compiler),path.join(root,"node_modules/typescript"),"dir");
    for (const [name, shape, body] of cases) writeFile(root,`src/m/${name}.ts`,header+`/** @implements ${name}${shape} */\nexport class ${name} {${body}}`);
    // Test the same intersection at the outer surface without an unrelated extra property.
    writeFile(root,"src/m/intersection.ts",'type Extra={};\n/** @implements WritableValue */\nexport const Writable:{readonly value:string}&{value:string}={value:""};\n/** @implements ReadonlyValue */\nexport const Readonly:Readonly<{value:string}>&Extra={value:""};');
    const result=checkLinking(root);
    for (const [name,,, compatible] of cases) assert.equal(result.linking.implementations.find(i=>i.name===name)?.compatible,compatible,`${compiler} ${name}: ${JSON.stringify(result.errors.filter(d=>d.file?.endsWith(`/${name}.ts`)))}`);
    for (const name of ["Writable", "Readonly"]) assert.equal(result.linking.implementations.find(i=>i.name===name)?.compatible,true,compiler+name);
    assert.ok(result.errors.every(d => d.code === "E_CONTRACT_SIGNATURE"), JSON.stringify(result.errors));
  }
});

/** @tests Cli
 * @covers exact-surface exact-signatures */
test("one inherited contract combines callable members and preserves overloads on TS5/TS6", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root=designProject(t,{m:mdx(data("Call","{(value:string):void;}"),data("Named","{label:string;}"),data("Runs","{run(value:string):void;run(value:number):void;}"),contract("NamedCall extends Call, Named",""),contract("Port extends Runs", ""))},{
      "src/m/call.ts":'/** @implements NamedCall */\nexport const call=Object.assign((value:string):void=>{}, {label:""});',
      "src/m/port.ts":'/** @implements Port */\nexport class Port {run(value:string):void; run(value:number):void; run(value:string|number):void{}}',
    });
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve("node_modules",compiler),path.join(root,"node_modules/typescript"),"dir");
    assert.deepEqual(checkLinking(root).errors,[],compiler);
    writeFile(root,"src/m/call.ts",'/** @implements NamedCall */\nexport const call=Object.assign((value:string,extra?:number):void=>{}, {label:""});');
    writeFile(root,"src/m/port.ts",'/** @implements Port */\nexport class Port {run(value:string):void; run(value:number):void; run(value:boolean):void; run(value:string|number|boolean):void{}}');
    const errors=checkLinking(root).errors;
    assert.equal(errors.length,2,JSON.stringify(errors));
    assert.ok(errors.every(d=>d.code==="E_CONTRACT_SIGNATURE"),compiler);
  }
});

/** @tests Cli
 * @covers exact-surface */
test("a malformed static implementation reports its syntax without a missing-contract cascade", (t) => {
  const root=designProject(t,{m:mdx(contract("Factory","create():string;"))},{"src/m/impl.ts":'/** @implements-static Factory */\nexport class Factory {static create(:string{return ""}}'});
  const errors=checkLinking(root).errors;
  assert.ok(errors.some(d=>d.code==="E_TYPESCRIPT"));
  assert.ok(errors.every(d=>d.code!=="E_IMPLEMENTATION_MISSING"));
});

/** @tests Cli
 * @covers exact-signatures */
test("setter substitutions stay separate across aliases, inherited generics and mapped properties", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root=designProject(t,{m:mdx(data("Box<T>","{get value():string;set value(x:T)}"),contract("Reader","get():Box<string>;"),contract("GoodReader","get():Box<string>;"),contract("Value","value:string;"),contract("OptionalValue","value?:string;"))},{
      "src/m/shared.ts":'import type {Box} from "./.cage/design.ts";\n/** @implements Reader */\nexport class SharedBad {get():Box<number>{throw new Error("fixture")}}\n/** @implements GoodReader */\nexport class SharedGood {get():Box<string>{throw new Error("fixture")}}',
      "src/m/inherited.ts":'class Base<T>{get value():T{throw 1} set value(x:T){}} class Mid<U> extends Base<U>{}\n/** @implements Value */\nexport class Inherited extends Mid<string>{}',
      "src/m/mapped.ts":'class Box<T>{get value():string{return ""} set value(x:T){}}\n/** @implements OptionalValue */\nexport const Mapped:Partial<Box<number>>={};',
    });
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve("node_modules",compiler),path.join(root,"node_modules/typescript"),"dir");
    const result=checkLinking(root);
    assert.equal(result.errors.length,1,JSON.stringify(result.errors));
    assert.equal(result.errors[0].code,"E_CONTRACT_SIGNATURE",compiler);
    assert.match(result.errors[0].message,/SharedBad/);
    for (const name of ["SharedGood","Inherited","Mapped"]) assert.equal(result.linking.implementations.find(i=>i.name===name)?.compatible,true,compiler+name);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("the recursive comparison guard counts pairs when only the design type expands", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root=designProject(t,{m:mdx(data("Tree<T>","{value:T extends string ? string : string;next?:Tree<T[]>}"),contract("Reader","read():Tree<string>;"))},{"src/m/impl.ts":'type Plain={value:string;next?:Plain};\n/** @implements Reader */\nexport class Reader {read():Plain{return {value:""}}}'});
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve("node_modules",compiler),path.join(root,"node_modules/typescript"),"dir");
    const errors=checkLinking(root).errors;
    assert.equal(errors.length,1,JSON.stringify(errors));
    assert.equal(errors[0].code,"E_CONTRACT_UNCHECKABLE",compiler);
  }
});
