// Structure input only. JMFS owns geometry planning and numerical acceptance.
export function pdbId(value){
  const id=String(value).trim();
  if(!/^(?:[1-9][a-z0-9]{3}|pdb_[a-z0-9]{8})$/i.test(id))throw Error('Enter a four-character PDB ID or an extended ID such as pdb_00004cha.');
  return id.toLowerCase().startsWith('pdb_')?id.toLowerCase():id.toUpperCase();
}
export const isCif=text=>/^\s*(?:#.*\n\s*)?data_/i.test(text);
export function cifTokens(text){
  const tokens=[];let i=0;
  while(i<text.length){
    if(/\s/.test(text[i])){i++;continue;}
    if(text[i]==='#'){while(i<text.length&&text[i]!=='\n')i++;continue;}
    if(text[i]===';'&&(i===0||text[i-1]==='\n')){
      const end=text.indexOf('\n;',i+1);if(end<0)throw Error('Unterminated mmCIF text field.');
      tokens.push(text.slice(i+1,end));i=end+2;continue;
    }
    if(text[i]==="'"||text[i]==='"'){
      const quote=text[i++],start=i;
      while(i<text.length&&!(text[i]===quote&&(i+1===text.length||/\s/.test(text[i+1]))))i++;
      if(i===text.length)throw Error('Unterminated mmCIF quoted value.');
      tokens.push(text.slice(start,i++));continue;
    }
    const start=i;while(i<text.length&&!/\s/.test(text[i]))i++;tokens.push(text.slice(start,i));
  }
  return tokens;
}
export function cifAtoms(text){
  const tokens=cifTokens(text),rows=[];
  for(let i=0;i<tokens.length;i++){
    if(tokens[i]!=='loop_')continue;
    const fields=[];while(tokens[i+1]?.startsWith('_'))fields.push(tokens[++i]);
    if(!fields.length)continue;
    const atomLoop=fields[0].startsWith('_atom_site.');
    while(i+1<tokens.length&&!/^(?:_|loop_|data_|save_|stop_)/.test(tokens[i+1])){
      const values=tokens.slice(i+1,i+1+fields.length);if(values.length!==fields.length)throw Error('Incomplete mmCIF loop row.');
      if(atomLoop){const row=Object.fromEntries(fields.map((key,n)=>[key.slice(11),values[n]]));rows.push(row);}
      i+=fields.length;
    }
  }
  if(!rows.length)throw Error('The mmCIF file has no atom_site loop.');
  return rows;
}
export function structureChains(text){
  return [...new Set(isCif(text)?cifAtoms(text).map(r=>r.auth_asym_id&&r.auth_asym_id!=='.'&&r.auth_asym_id!=='?'?r.auth_asym_id:r.label_asym_id):text.split(/\r?\n/).filter(l=>l.startsWith('ATOM  ')||l.startsWith('HETATM')).map(l=>l.slice(21,22).trim()||'_'))];
}
export async function fetchStructure(id,chain='',signal){
  id=pdbId(id);chain=chain.trim();
  const response=await fetch('https://files.rcsb.org/download/'+id+'.cif',{signal});
  if(!response.ok)throw Error('RCSB could not load '+id+' ('+response.status+').');
  if(Number(response.headers.get('Content-Length'))>20_000_000)throw Error('Choose a structure smaller than 20 MB.');
  const text=await response.text();if(text.length>20_000_000)throw Error('Choose a structure smaller than 20 MB.');
  const chains=structureChains(text);
  if(chain&&!chains.includes(chain))throw Error('Chain '+chain+' was not found. Available author chains: '+chains.join(', '));
  return {id,text,chains,chain};
}
