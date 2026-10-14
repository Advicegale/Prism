"""Graphify-wide entry plus non-baseline composition/module evidence."""
from pathlib import Path
import pytest
from prism.exploration.analyzer import analyze
from prism.exploration.graphify_adapter import configurations, registry
from prism.exploration.query import Index, Query
from prism.exploration import service
from test_exploration import select, complete, SHA


ROOTS={
    'go': 'package sample\nfunc helper() int { return 1 }\n',
    'rs': 'pub fn helper() -> i32 { 1 }\n',
    'rb': 'def helper\n  1\nend\n',
    'c': 'int helper(void) { return 1; }\n',
    'cpp': 'int helper() { return 1; }\n',
    'cs': 'class Example { public int helper() { return 1; } }\n',
    'kt': 'fun helper(): Int { return 1 }\n',
    'scala': 'object Example { def helper(): Int = 1 }\n',
    'php': '<?php function helper() { return 1; }\n',
    'swift': 'func helper() -> Int { return 1 }\n',
    'lua': 'function helper() return 1 end\n',
    'zig': 'pub fn helper() u32 { return 1; }\n',
    'sh': 'helper() { printf "hi"; }\n',
    'ex': 'defmodule Example do\n  def helper() do\n    1\n  end\nend\n',
    'erl': '-module(example).\n-export([helper/0]).\nhelper() -> 1.\n',
    'jl': 'function helper()\n  return 1\nend\n',
    'f90': 'function helper() result(n)\n  integer :: n\n  n = 1\nend function helper\n',
    'dart': 'int helper() { return 1; }\n',
    'ml': 'let helper x = x + 1\n',
    'lisp': '(defun helper (x) (+ x 1))\n',
    'v': 'module helper(input a, output b); assign b = a; endmodule\n',
    'sql': 'CREATE TABLE helper (id INTEGER PRIMARY KEY);\n',
    'pas': 'program Example;\nfunction helper: Integer;\nbegin helper := 1; end;\nbegin end.\n',
    'sol': 'pragma solidity ^0.8.0;\ncontract Example { function helper() public pure returns(uint) { return 1; } }\n',
    'ps1': 'function helper { return 1 }\n',
    'vb': 'Module Example\nFunction helper() As Integer\nReturn 1\nEnd Function\nEnd Module\n',
    'groovy': 'class Example { int helper() { return 1 } }\n',
    'cbl': '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. helper.\n       PROCEDURE DIVISION.\n           STOP RUN.\n',
    'tf': 'resource "aws_s3_bucket" "helper" { bucket = "example" }\n',
    'robot': '*** Keywords ***\nhelper\n    Log    hello\n',
    'dm': '/proc/helper()\n    return 1\n',
    'mm': '@interface Example\n- (int)helper;\n@end\n@implementation Example\n- (int)helper { return 1; }\n@end\n',
    'vue': '<script setup>\nfunction helper() { return 1; }\n</script>\n<template><div>hello</div></template>\n',
    'svelte': '<script>\nfunction helper() { return 1; }\n</script>\n<div>hello</div>\n',
    'astro': '---\nfunction helper() { return 1; }\n---\n<div>hello</div>\n',
}


@pytest.mark.parametrize('extension',ROOTS)
def test_graphify_language_declarations_are_real_source_roots(extension):
    path='example.'+extension;index=Index(analyze({path:ROOTS[extension]},SHA))
    chosen=select(index,path,'helper')
    assert chosen['status']=='resolved', (extension,chosen,index.facts.coverage)
    anchor=chosen['root']['definition'];assert anchor['path']==path and anchor['revision']==SHA
    assert index.facts.sources[path].encode()[anchor['start_byte']:anchor['end_byte']]==b'helper'
    projection=complete(index,chosen['root']);assert projection['nodes'][0]['path']==path


COMPOSITIONS={
    'go': {'prefs/prefs.go':'package prefs\ntype Network struct { Attempts int }\nvar Settings = Network{Attempts: 4}\n',
           'bridge/bridge.go':'package bridge\nimport p "fixture/prefs"\nvar Channel = assemble(p.Settings)\nvar Backup = assemble(p.Settings)\n',
           'shell/shell.go':'package shell\nimport b "fixture/bridge"\ntype Wrapper struct { Wire interface{} }\nvar Service = Wrapper{Wire: b.Channel}\n', 'go.mod':'module fixture\ngo 1.24\n'},
    'ruby': {'prefs.rb':'Settings = { network: { attempts: 4 }, logging: { level: 1 } }\n',
             'bridge.rb':'require_relative "prefs"\nChannel = assemble(Settings[:network])\nBackup = assemble(Settings[:network])\nLogger = assemble(Settings[:logging])\n',
             'shell.rb':'require_relative "bridge"\nService = { wire: Channel }\n'},
    'rust': {'lib.rs':'mod prefs; mod bridge; mod shell;\n',
             'prefs.rs':'pub struct Network { pub attempts: i32 }\npub const SETTINGS: Network = Network { attempts: 4 };\n',
             'bridge.rs':'use crate::prefs::SETTINGS;\npub const CHANNEL: Client = assemble(SETTINGS);\npub const BACKUP: Client = assemble(SETTINGS);\n',
             'shell.rs':'use crate::bridge::CHANNEL;\npub const SERVICE: Wrapper = Wrapper { wire: CHANNEL };\n'},
    'c': {'prefs.h':'struct Options { int attempts; };\nstatic struct Options settings = { .attempts = 4 };\n',
          'bridge.h':'#include "prefs.h"\nstatic struct Client *channel = assemble(settings);\nstatic struct Client *backup = assemble(settings);\n',
          'shell.c':'#include "bridge.h"\nstruct Service service = { .wire = channel };\n'},
    'lua': {'prefs.lua':'local settings = { network = { attempts = 4 }, logging = { level = 1 } }\nreturn settings\n',
            'bridge.lua':'local settings = require("prefs")\nlocal channel = assemble(settings.network)\nlocal backup = assemble(settings.network)\nreturn { channel = channel, backup = backup }\n',
            'shell.lua':'local bridge = require("bridge")\nlocal service = { wire = bridge.channel }\n'},
}


@pytest.mark.parametrize('family',COMPOSITIONS)
def test_nonbaseline_field_factory_wrapper_and_cross_file_bindings(family):
    sources=COMPOSITIONS[family];index=Index(analyze(sources,SHA))
    path=next(p for p in sources if 'prefs' in p);name='Attempts' if family=='go' else 'attempts'
    # Last occurrence is the initialized owned value, not the type definition.
    chosen=select(index,path,name,sources[path].count(name)-1);assert chosen['status']=='resolved'
    result=complete(index,chosen['root']);paths={n['path'] for n in result['nodes']}
    shell=next(p for p in sources if 'shell' in p);assert shell in paths
    assert any('wire' in s['name'].lower() for n in result['nodes'] for s in n['symbols'])
    assert not any('logger' in s['name'].lower() for n in result['nodes'] for s in n['symbols'])
    bridge=next(p for p in sources if 'bridge' in p);channel='CHANNEL' if family=='rust' else 'Channel' if family in {'go','ruby'} else 'channel'
    selected=select(index,bridge,channel);assert selected['status']=='resolved'
    scoped=complete(index,selected['root'])
    assert not any('backup' in s['name'].lower() for n in scoped['nodes'] for s in n['symbols'])
    origins=complete(index,selected['root'],direction='origins');assert path in {n['path'] for n in origins['nodes']}


def test_future_graphify_dispatch_and_shebang_enable_without_prism_allowlist(monkeypatch):
    from graphify import extract
    monkeypatch.setitem(extract._DISPATCH,'.future',extract.extract_dart)
    configurations.cache_clear()
    try:
        sources={'sample.future':'int helper() { return 1; }\n','bin/tool':'#!/usr/bin/env bash\nhelper() { printf "hello"; }\n'}
        index=Index(analyze(sources,SHA))
        assert select(index,'sample.future','helper')['status']=='resolved'
        assert select(index,'bin/tool','helper')['status']=='resolved'
        assert index.facts.coverage['providers']['sample.future']=='extract_dart'
    finally:configurations.cache_clear()


def test_new_custom_extractor_registration_has_no_prism_provider_name_gate(monkeypatch):
    from graphify import extract
    def future_provider(path):
        return {'nodes':[{'id':'future_helper','label':'helper()','file_type':'code','source_file':str(path),'source_location':'L1'}], 'edges':[]}
    monkeypatch.setitem(extract._DISPATCH,'.future',future_provider)
    index=Index(analyze({'sample.future':'fn helper() { return 1; }'},SHA))
    assert select(index,'sample.future','helper')['status']=='resolved'


def test_registry_or_parser_install_changes_cache_identity(monkeypatch,tmp_path):
    from graphify import extract
    root=tmp_path/'repos'/'example'/'worktree';root.mkdir(parents=True)
    before=service.cache_key(root,SHA)
    monkeypatch.setitem(extract._DISPATCH,'.future',extract.extract_dart)
    assert service.cache_key(root,SHA)!=before


def test_native_missing_parser_is_a_specific_partial_state(monkeypatch):
    from prism.exploration import native
    monkeypatch.setattr(native,'native_extract',lambda _:({'nodes':[],'edges':[]},{'sample.future':'extract_dart'}, {'sample.future':'optional language parser missing'}))
    index=Index(analyze({'sample.future':'helper()'},SHA))
    selected=select(index,'sample.future','helper')
    assert selected['status']=='partial' and 'optional language parser missing' in selected['reason']


@pytest.mark.parametrize('extension,code,root,target',[
    ('cs','class Settings { public static object network = new Network(4); public static object logging = new Logging(1); }\nclass Bridge { public static object channel = assemble(Settings.network); public static object logger = assemble(Settings.logging); }\nclass Wrapper { public object wire = Bridge.channel; }\n','network','wire'),
    ('kt','object Settings { val network = Network(4); val logging = Logging(1); }\nval channel = assemble(Settings.network)\nval logger = assemble(Settings.logging)\nval wrapper = Wrapper(channel)\n','network','wrapper'),
    ('swift','struct Config { let attempts: Int }\nlet settings = Config(attempts: 4)\nlet channel = assemble(settings)\nlet wrapper = Wrapper(wire: channel)\n','attempts','wrapper'),
    ('php','<?php\n$settings = ["network" => ["attempts" => 4], "logging" => 1];\n$channel = assemble($settings["network"]);\n$logger = assemble($settings["logging"]);\n$wrapper = ["wire" => $channel];\n','attempts','wrapper'),
])
def test_shared_constructor_and_static_member_shapes(extension,code,root,target):
    path='model.'+extension;index=Index(analyze({path:code},SHA));chosen=select(index,path,root)
    assert chosen['status']=='resolved'
    result=complete(index,chosen['root']);names=[s['name'] for n in result['nodes'] for s in n['symbols']]
    assert any(target in name for name in names)
    assert not any('logger' in name for name in names)
    channel=select(index,path,'channel');assert channel['status']=='resolved'
    origins=complete(index,channel['root'],direction='origins')
    assert any(root in s['name'] or 'settings' in s['name'] for n in origins['nodes'] for s in n['symbols'])


def test_generic_lexical_shadowing_and_operation_results_are_excluded():
    sources={'sample.go':'package sample\ntype Config struct { Attempts int }\nvar settings = Config{Attempts: 4}\nvar channel = assemble(settings)\nvar wrapper = Envelope{Wire: channel}\nvar response = channel.Send(order)\nvar unrelated = Envelope{Wire: response}\nfunc process(channel int) { local := assemble(channel); _ = local }\n'}
    index=Index(analyze(sources,SHA));root=select(index,'sample.go','channel')
    result=complete(index,root['root']);names=[s['name'] for n in result['nodes'] for s in n['symbols']]
    assert 'wrapper.Wire' in names and 'unrelated.Wire' not in names and 'local' not in names
    assert any(b['kind']=='usage' for b in result['boundaries'])


def test_typed_initializer_source_does_not_repeat_highlight_spans(monkeypatch):
    code='package prefs\ntype Network struct { Attempts int }\nvar Config = Network{Attempts: 4}\n'
    index=Index(analyze({'config.go':code},SHA))
    monkeypatch.setattr(service,'index_job',lambda *_:{'status':'ready','index':index,'revision':SHA})
    source=service.source({'id':'fixture'},'config.go','new',3)
    spans=[(a['start_byte'],a['end_byte']) for a in source['anchors']]
    assert len(spans)==len(set(spans))
    assert source['code']==code and source['code'].count('Attempts')==2


def test_namespace_binding_preserves_import_evidence_and_excludes_sibling_composition():
    sources={**COMPOSITIONS['go'], 'logger/logger.go':'package logger\nimport bridge "fixture/bridge"\nvar Noise = Envelope{Unused: bridge.Backup}\n'}
    index=Index(analyze(sources,SHA));chosen=select(index,'bridge/bridge.go','Channel')
    result=complete(index,chosen['root']);names=[s['name'] for n in result['nodes'] for s in n['symbols']]
    # A whole-package import can carry Channel even when this file uses Backup;
    # it must not make Noise/Backup into Channel's derived composition.
    assert not any('Noise' in name or 'Backup' in name for name in names)
    screen=next(e for e in result['connections'] if e['target']=='shell/shell.go')
    assert any(e['kind']=='import' and e['anchor']['path']=='shell/shell.go' for e in screen['evidence'])
