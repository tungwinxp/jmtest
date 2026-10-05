// One tab owns the search workers until that tab closes.
// Web Locks releases ownership automatically when the document is destroyed.
let ownership;
export function claimCompute(){
  if(ownership)return ownership;
  if(!navigator.locks)return Promise.reject(Error('This browser cannot prevent duplicate compute tabs. Use a browser with Web Locks support.'));
  ownership=new Promise((resolve,reject)=>{
    navigator.locks.request('jmfs-compute-owner',{ifAvailable:true},lock=>{
      if(!lock){reject(Error('JMFS compute is already open in another tab. Close that tab before starting here.'));return;}
      resolve();return new Promise(()=>{});
    }).catch(reject);
  }).catch(error=>{ownership=null;throw error;});
  return ownership;
}
