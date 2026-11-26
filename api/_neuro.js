const {getProfile,setProfile,london}=require('./_db');
const {lifeState}=require('./_life');
async function daily(){
 const s=await lifeState(), p=s.profile, date=london().date;
 let goals=[];try{goals=JSON.parse(p.neuro_goals||'[]')}catch{}
 if(!Array.isArray(goals))goals=[];
 const habits=s.habits.filter(h=>h.kind!=='prayer'||p.neuro_islamic_mode==='true');
 return {date,private:!!s.private.on,goals:goals.filter(g=>g.date===date),habits:habits.map(h=>({name:h.name,today:h.today,streak:h.streak})),insights:s.private.on?[]:habits.filter(h=>!h.today&&h.streak>=3).slice(0,3).map(h=>({text:'Protect your '+h.name+' streak today.',evidence:h.streak+' consecutive logged days',source:'habit records'}))};
}
async function goal(b){
 const title=String(b.title||'').trim().slice(0,180);
 if(!title)return {ok:false,error:'Enter a priority'};
 const p=await getProfile(),date=london().date;
 let goals=[];try{goals=JSON.parse(p.neuro_goals||'[]')}catch{}
 if(!Array.isArray(goals))goals=[];
 goals=goals.filter(g=>g.date===date);
 if(b.done===true){const g=goals.find(g=>g.title===title);if(!g)return {ok:false,error:'Priority not found'};g.done=true;}
 else if(!goals.some(g=>g.title===title)){if(goals.length>=5)return {ok:false,error:'Maximum five daily priorities'};goals.push({title,date,done:false});}
 await setProfile('neuro_goals',JSON.stringify(goals));return {ok:true,goals};
}
module.exports={daily,goal};
