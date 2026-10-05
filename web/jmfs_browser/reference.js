import {parsePdb} from './query.js';

const quote=value=>'"'+value.replaceAll('"','').replaceAll('\\','')+'"';
const normalize=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
async function json(url,signal){
  const response=await fetch(url,{signal});
  if(!response.ok)throw Error('Reference lookup failed ('+response.status+').');
  return response.json();
}
// Named enzymes use source annotations, never an enzyme-to-residue preset table.
export async function lookupReference({name,organism,accession},references,signal){
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
  if(!accession&&(!name||!organism))throw Error('Supply an enzyme name and its reference organism. The target database is a separate choice.');
  // An accession names one reviewed entry exactly; a name and organism may match several.
  const query=accession?`accession:${quote(accession)} AND reviewed:true AND ft_act_site:*`:`protein_name:${quote(name)} AND organism_name:${quote(organism)} AND reviewed:true AND ft_act_site:*`;
  const url='https://rest.uniprot.org/uniprotkb/search?'+new URLSearchParams({query,format:'json',size:'10'});
  const data=await json(url,signal),candidates=[],failures=[];
  const matches=(data.results||[]).filter(entry=>accession||normalize(entry.proteinDescription?.recommendedName?.fullName?.value||'').includes(normalize(name))&&!/\blike\b/i.test(entry.proteinDescription?.recommendedName?.fullName?.value||''));
  for(const entry of matches.slice(0,3)){
    try{
      const accession=entry.primaryAccession;
      const sites=(entry.features||[]).filter(f=>f.type==='Active site'&&f.location?.start?.value===f.location?.end?.value).map(f=>({position:f.location.start.value,description:f.description,evidence:f.evidences}));
      if(sites.length<2||sites.length>10)continue;
      const predictions=await json('https://alphafold.ebi.ac.uk/api/prediction/'+encodeURIComponent(accession),signal);
      const prediction=predictions.find(p=>p.uniprotAccession===accession&&(p.sequenceStart??p.uniprotStart)===1&&(p.sequenceEnd??p.uniprotEnd)===entry.sequence.length);
      if(!prediction)throw Error('No complete AlphaFold reference is available.');
      const structureUrl=new URL(prediction.pdbUrl);
      if(structureUrl.protocol!=='https:'||structureUrl.hostname!=='alphafold.ebi.ac.uk')throw Error('Unexpected structure host.');
      const response=await fetch(structureUrl,{signal});if(!response.ok)throw Error('Reference structure unavailable.');
      const text=await response.text();if(text.length>20_000_000)throw Error('Reference structure exceeds 20 MB.');
      const residues=parsePdb(text,{residueCode:()=>0}),chains=[...new Set(residues.map(r=>r.chain))];
      if(chains.length!==1)throw Error('Reference numbering is ambiguous.');
      const chain=chains[0],letters={ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V'};
      for(const r of residues)if(letters[r.resName]!==entry.sequence.value[r.resSeq-1])throw Error('Reference sequence does not match UniProt numbering.');
      const positions=new Set(residues.map(r=>r.resSeq));
      if(sites.some(s=>!positions.has(s.position)))throw Error('An annotated catalytic residue is absent from the reference.');
      // One neighboring anchor on either side supplies local backbone context.
      const motif=sites.map(s=>{const start=positions.has(s.position-1)?s.position-1:s.position,end=positions.has(s.position+1)?s.position+1:s.position;return chain+start+(end!==start?'-'+end:'');}).join(',');
      const chemistry_positions=sites.map(s=>chain+s.position).join(',');
      const reference_id='uniprot:'+accession;
      const result={reference_id,name:entry.proteinDescription.recommendedName.fullName.value,organism:entry.organism.scientificName,motif,chemistry_positions,chemistry:'exact',sites,
        evidence:'Reviewed UniProt active-site annotations; evidence codes may indicate transfer by similarity. Geometry is an AlphaFold prediction, not an experimental structure.',
        sources:['https://www.uniprot.org/uniprotkb/'+accession+'/entry',structureUrl.href]};
      try{
        const mcsa=await json('https://www.ebi.ac.uk/thornton-srv/m-csa/api/entries/?'+new URLSearchParams({'entries.proteins.sequences.uniprot_ids':accession,format:'json'}),signal);
        result.mcsa=(mcsa.results||[]).slice(0,3).map(e=>({id:e.mcsa_id,name:e.enzyme_name,reference_uniprot_id:e.reference_uniprot_id,is_reference_uniprot_id:e.is_reference_uniprot_id}));
        for(const item of result.mcsa)result.sources.push('https://www.ebi.ac.uk/thornton-srv/m-csa/entry/'+item.id+'/');
      }catch(error){if(signal?.aborted)throw error;result.mcsa_note='M-CSA lookup unavailable; UniProt active-site evidence remains the source.';}
      references.set(reference_id,{...result,text,chain,id:accession});candidates.push(result);
    }catch(error){if(signal?.aborted)throw error;failures.push({accession:entry.primaryAccession,error:error.message});}
  }
  return {candidates,failures,note:candidates.length?undefined:'No reviewed enzyme with annotated catalytic residues matched. Check the name and organism, or give a PDB entry and residues.'};
}
