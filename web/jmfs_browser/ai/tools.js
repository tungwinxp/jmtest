// Hints constrain explicit fields; they never execute or choose a scientific reference.
export function parseHints(text){
  const lower=text.toLowerCase().replaceAll('’',"'");
  const noRun=/\b(?:do not|don't|dont|not yet|never)\s+(?:\w+\s+){0,2}(?:run|search|execute)\b|\b(?:before|without)\s+(?:running|searching)\b/.test(lower);
  const run=!noRun&&/\b(?:run|search|searched|execute|find hits)\b/.test(lower)&&!/\b(?:how|why|what|explain)\b.*\b(?:run|search|searched)\b/.test(lower);
  const ids=[...text.matchAll(/\b(?:pdb_[a-zA-Z0-9]{8}|[1-9][a-zA-Z0-9]{3})\b/gi)].map(m=>/^pdb_/i.test(m[0])?m[0].toLowerCase():m[0].toUpperCase());
  const ranges=[...text.matchAll(/\b([a-zA-Z_]+)(-?\d+)(?:-(-?\d+))?(?![\w])/g)].filter(m=>!/^pdb_/i.test(m[0])).map(m=>m[1]+m[2]+(m[3]?'-'+m[3]:''));
  const threshold=text.match(/(?:at|cutoff(?: to)?|rmsd(?: of| to|=)?|threshold(?: to)?)\s*(\d+(?:\.\d+)?)\s*(?:Å|angstroms?|A\b|Å)|\b(\d+(?:\.\d+)?)\s*(?:Å|angstroms?|Å)/i);
  const target=lower.match(/\b(?:on|against|in)\s+(?:the\s+)?(human|afdb\s*50|nufold|esm(?:\s+atlas)?|example|demo)\b/)?.[1]??lower.match(/\b(human|afdb\s*50|nufold|esm(?:\s+atlas)?|example|demo)\s+(?:database|proteome|db)\b/)?.[1];
  const database=target?.replace(/\s+/g,'').replace('demo','example').replace('esmatlas','esm');
  const chemistry=/\b(?:no|without|disable)\s+chemistry\b|\bshape.only\b/.test(lower)?'none':/\bexact\s+chemistry\b/.test(lower)?'exact':/\breduced\s+chemistry\b/.test(lower)?'reduced':undefined;
  return {pdb_ids:ids,ranges,database,rmsd:threshold?Number(threshold[1]??threshold[2]):undefined,chemistry,run,noRun,
    setup:/\b(?:use|load|set|setup|change|search|searched|run)\b/.test(lower),
    chain:text.match(/\bchain\s+([A-Za-z0-9_]+)\b/i)?.[1],
    external:/\b(?:rcsb|prosite|sequence search|structural motif search|look up|lookup|in (?:the )?pdb)\b/.test(lower)||(/\b(?:what|describe|tell)\b/.test(lower)&&ids.length>0),
    view:/\b(?:show|hide|view|display|rotate|turn|zoom|pan|center|centre|focus|colou?r|sidechains?|overlap|download|export)\b/.test(lower),
    annotations:/\b(?:sugars?|ligands?|bind(?:ing)?|bound|function|activity|annotations?|evidence)\b/.test(lower),
    unsupported:/\b(?:fdp|folddisco|prefilter|insertion)\b/.test(lower)};
}
export function draftFromHints(hints,state){
  if(!hints.setup)return {};
  if(hints.unsupported)throw Error('This workbench does not expose sequence/FDP prefilter controls or insertion-code selectors.');
  const draft={};
  if(hints.pdb_ids.length>1)throw Error('Choose one reference PDB for this query.');
  if(hints.pdb_ids.length)draft.pdb_id=hints.pdb_ids[0];
  if(hints.ranges.length)draft.motif=hints.ranges.join(',');
  if(hints.rmsd!==undefined)draft.rmsd=hints.rmsd;
  if(hints.chemistry)draft.chemistry=hints.chemistry;
  if(hints.database){
    const found=state.databases.filter(db=>db.available&&(hints.database==='example'?db.example:!db.example&&db.name.toLowerCase().includes(hints.database==='human'?'homo sapiens':hints.database)));
    if(found.length!==1)throw Error('Choose '+hints.database+' in the database list; I could not resolve it unambiguously.');
    draft.database_ids=[found[0].id];
  }
  return draft;
}
export function makeTools(z){
  const small=z.string().min(1).max(240),pdb=z.string().regex(/^(?:[1-9][A-Za-z0-9]{3}|pdb_[a-zA-Z0-9]{8})$/i),selection=z.string().max(200).regex(/^[A-Za-z_]+\d+(?:-\d+)?(?:,[A-Za-z_]+\d+(?:-\d+)?)*$/);
  const schemas={
    motif_lookup:z.object({name:small.optional(),organism:small.optional(),pdb_id:pdb.optional()}).strict(),
    pdb_find:z.object({query:small,limit:z.number().int().min(1).max(25).default(10)}).strict(),
    pdb_get:z.object({pdb_ids:z.array(pdb).min(1).max(25)}).strict(),
    pdb_sequence_search:z.object({mode:z.enum(['motif','similarity']),pattern:small,pattern_type:z.enum(['prosite','regex','simple']).default('prosite'),polymer_type:z.enum(['protein','rna','dna']).default('protein'),limit:z.number().int().min(1).max(25).default(10)}).strict(),
    pdb_structural_motif_search:z.object({pdb_id:pdb,residues:z.array(z.object({label_asym_id:small,label_seq_id:z.number().int().positive()}).strict()).min(2).max(10),rmsd:z.number().min(.001).max(100).default(2),limit:z.number().int().min(1).max(25).default(10)}).strict(),
    set_jmfs_query:z.object({reference_id:small.optional(),pdb_id:pdb.optional(),chain:small.optional(),motif:selection.optional(),chemistry_positions:selection.optional(),chemistry:z.enum(['none','exact','reduced']).optional(),rmsd:z.number().min(.001).max(100).optional(),limit:z.number().int().min(1).max(10000).optional(),database_ids:z.array(z.string().regex(/^\d+$/)).min(1).max(4).optional(),cpu:z.enum(['auto','cpu']).optional()}).strict(),
    run_jmfs_query:z.object({}).strict(),
    protein_view:z.object({action:z.enum(['motif','whole','query','target','focus','visibility','select_hit','color','reset_colors','rotate','zoom','pan','download']),hit_rank:z.number().int().min(1).max(10000).optional(),query:z.boolean().optional(),target:z.boolean().optional(),motif_only:z.boolean().optional(),sidechains:z.boolean().optional(),chains:z.array(small).max(100).optional(),part:z.enum(['chain0','chain1','chain2','chain3','queryMatch','target','targetMatch','chemistry']).optional(),color:z.string().regex(/^#[\da-f]{6}$/i).optional(),angle:z.number().min(-360).max(360).optional(),axis:z.enum(['x','y','z']).optional(),factor:z.number().min(.1).max(10).optional(),dx:z.number().min(-1000).max(1000).optional(),dy:z.number().min(-1000).max(1000).optional()}).strict(),
    annotate_hits:z.object({limit:z.number().int().min(1).max(10).default(5)}).strict(),
    search_motif:z.object({name:small,organism:small,database_ids:z.array(z.string().regex(/^\d+$/)).min(1).max(4),chemistry:z.enum(['none','exact','reduced']).optional(),rmsd:z.number().min(.001).max(100).optional(),limit:z.number().int().min(1).max(10000).optional()}).strict(),
  };
  const descriptions={
    motif_lookup:'Find verified catalytic residues. Supply enzyme name WITHOUT species plus organism, or a pdb_id for M-CSA annotations. Returns reference_id and verified selections; no memorized enzyme presets.',
    pdb_find:'Find PDB entries by keyword using RCSB MCP.',
    pdb_get:'Get verified PDB metadata using RCSB MCP.',
    pdb_sequence_search:'Search PDB with a supplied sequence or PROSITE pattern.',
    pdb_structural_motif_search:'Search PDB with verified mmCIF label residue IDs.',
    set_jmfs_query:'Set the visible form. For a verified motif supply reference_id and database_ids ONLY; the tool fills verified residue selections. Otherwise use explicit settings. Use REQUESTED_FIELDS for user-specified settings.',
    run_jmfs_query:'Run the visible JMFS query once when the user explicitly asks to search.',
    protein_view:'Change the current protein display using VIEWER_CONTEXT chain IDs. Hit ranks are 1-based; colors are hex; rotation is degrees, zoom factor >1 zooms in, pan is pixels. Sidechains displays existing chemistry-gated atoms only. Never changes search settings.',
    annotate_hits:'Download UniProt function and ligand-binding evidence for the top retained hits (default 5, max 10 distinct proteins). Use for questions about sugars or other ligands. No structural match proves binding; missing annotations are unknown. Returns source links and evidence codes. Sends public accession IDs only.',
    search_motif:'Find and search a verified catalytic motif in one action. Supply enzyme name WITHOUT species, reference organism and target database_ids. Fetches source annotations and geometry, preserves verified ranges, sets the visible query, then runs once. Uses a unique matching reference name; ambiguous choices return candidates for motif_lookup/set_jmfs_query instead. No enzyme presets or guessed residues.',
  };
  // Runtime validation retains all bounds. Keep the model grammar small.
  const parameters=schema=>JSON.parse(JSON.stringify(z.toJSONSchema(schema,{target:'draft-7'}),(key,value)=>['$schema','pattern','minLength','maxLength','minimum','maximum','default'].includes(key)?undefined:value));
  return {schemas,definitions:Object.entries(schemas).map(([name,schema])=>({type:'function',function:{name,description:descriptions[name],parameters:parameters(schema)}}))};
}
