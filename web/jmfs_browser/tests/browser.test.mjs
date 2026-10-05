import test from 'node:test';
import assert from 'node:assert/strict';
import {pdbId,cifAtoms} from '../structure.js';
import {parsePdb} from '../query.js';
import {HttpRangeSource} from '../jmfs_index.js';

test('PDB identifiers accept classic and extended forms',()=>{
  assert.equal(pdbId('PDB_00004CHA'),'pdb_00004cha');
  assert.throws(()=>pdbId('pdb_123'),/PDB ID/);
});

test('mmCIF retains author chains, labels, physical runs and first model',()=>{
  const cif=`data_test
loop_
_atom_site.group_PDB
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.auth_asym_id
_atom_site.label_seq_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM CA . HIS X AB 1 57 1 2 3 1
ATOM CA B HIS X AB 1 57 8 8 8 1
ATOM CA . ASP Y AB 2 102 4 5 6 1
ATOM CA . SER Z C 3 195 7 8 9 1
ATOM CA . SER Z C 3 195 9 9 9 2
#`;
  assert.equal(cifAtoms(cif).length,5);
  const rows=parsePdb(cif,{residueCode:()=>0});
  assert.deepEqual(rows.map(r=>[r.chain,r.resSeq,r.sourceRun,r.coord]),[['AB',57,0,[1,2,3]],['AB',102,1,[4,5,6]],['C',195,2,[7,8,9]]]);
});

test('Range reads verify intervals and reject silent full downloads',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(new Uint8Array(4),{status:206,headers:{'Content-Range':'bytes 4-7/16'}});
    await assert.rejects(new HttpRangeSource('https://example.invalid/index').read(0,4),/does not match/);
    globalThis.fetch=async()=>new Response(new Uint8Array(4),{status:200});
    await assert.rejects(new HttpRangeSource('https://example.invalid/index').read(0,4),/ignored HTTP Range/);
  }finally{globalThis.fetch=original;}
});

