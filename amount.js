function portion(amount,quantity,total) {
  return Number(BigInt(amount)*BigInt(quantity)/BigInt(total));
}
function allocate(amount,weights) {
  const total=weights.reduce((sum,n)=>sum+n,0);
  if (!total) return weights.map(()=>0);
  let weight=0,previous=0;
  return weights.map(n=>{
    weight+=n;
    const cumulative=portion(amount,weight,total);
    const share=cumulative-previous;
    previous=cumulative;
    return share;
  });
}
module.exports={portion,allocate};
