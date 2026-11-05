#include "ocgapi.h"
#include <stdlib.h>
#include <string.h>
#define EXP(n) __attribute__((export_name(n)))
// Host (JS) imports
__attribute__((import_module("host"),import_name("read_card"))) extern "C" void host_read_card(uint32_t code, uint32_t* out);
__attribute__((import_module("host"),import_name("read_script"))) extern "C" int host_read_script(OCG_Duel d, const char* name);
__attribute__((import_module("host"),import_name("log"))) extern "C" void host_log(const char* s, int type);
static uint16_t g_setcodes[17];
static void card_reader(void*, uint32_t code, OCG_CardData* d){
  // flat u32 layout: code,alias,type,level,attr,race_lo,race_hi,atk,def,lscale,rscale,link,setcode0..15
  uint32_t o[40]; memset(o,0,sizeof o); host_read_card(code,o);
  memset(d,0,sizeof *d); memset(g_setcodes,0,sizeof g_setcodes);
  d->code=code; d->alias=o[1]; d->type=o[2]; d->level=o[3]; d->attribute=o[4];
  d->race=((uint64_t)o[6]<<32)|o[5]; d->attack=(int32_t)o[7]; d->defense=(int32_t)o[8];
  d->lscale=o[9]; d->rscale=o[10]; d->link_marker=o[11];
  for(int i=0;i<16;i++) g_setcodes[i]=(uint16_t)o[12+i];
  d->setcodes=g_setcodes;
}
static void card_done(void*, OCG_CardData*){}
static int script_reader(void*, OCG_Duel d, const char* name){ return host_read_script(d,name); }
static void log_handler(void*, const char* s, int t){ host_log(s,t); }
extern "C" {
EXP("ygo_alloc") void* ygo_alloc(uint32_t n){ return malloc(n); }
EXP("ygo_free") void ygo_free(void* p){ free(p); }
EXP("ygo_create") OCG_Duel ygo_create(uint32_t s0,uint32_t s1,uint32_t lp,uint32_t startDraw,uint32_t perTurn,uint32_t flagsLo,uint32_t flagsHi){
  OCG_DuelOptions o; memset(&o,0,sizeof o);
  o.seed[0]=s0; o.seed[1]=s1; o.seed[2]=s0^0x9e3779b9u; o.seed[3]=s1^0x85ebca6bu;
  o.flags=((uint64_t)flagsHi<<32)|flagsLo;
  o.team1={lp,startDraw,perTurn}; o.team2=o.team1;
  o.cardReader=card_reader; o.scriptReader=script_reader; o.logHandler=log_handler; o.cardReaderDone=card_done;
  OCG_Duel d=nullptr; int r=OCG_CreateDuel(&d,&o); return r==0?d:nullptr;
}
EXP("ygo_destroy") void ygo_destroy(OCG_Duel d){ OCG_DestroyDuel(d); }
EXP("ygo_new_card") void ygo_new_card(OCG_Duel d,uint32_t code,uint32_t team,uint32_t duelist,uint32_t con,uint32_t loc,uint32_t seq,uint32_t pos){
  OCG_NewCardInfo i; i.team=team; i.duelist=duelist; i.code=code; i.con=con; i.loc=loc; i.seq=seq; i.pos=pos; OCG_DuelNewCard(d,&i);
}
EXP("ygo_start") void ygo_start(OCG_Duel d){ OCG_StartDuel(d); }
EXP("ygo_process") int ygo_process(OCG_Duel d){ return OCG_DuelProcess(d); }
EXP("ygo_get_message") void* ygo_get_message(OCG_Duel d,uint32_t* len){ return OCG_DuelGetMessage(d,len); }
EXP("ygo_set_response") void ygo_set_response(OCG_Duel d,const void* b,uint32_t n){ OCG_DuelSetResponse(d,b,n); }
EXP("ygo_load_script") int ygo_load_script(OCG_Duel d,const char* b,uint32_t n,const char* name){ return OCG_LoadScript(d,b,n,name); }
EXP("ygo_query_field") void* ygo_query_field(OCG_Duel d,uint32_t* len){ return OCG_DuelQueryField(d,len); }
EXP("ygo_query_count") uint32_t ygo_query_count(OCG_Duel d,uint32_t team,uint32_t loc){ return OCG_DuelQueryCount(d,team,loc); }
EXP("ygo_query") void* ygo_query(OCG_Duel d,uint32_t* len,uint32_t flags,uint32_t con,uint32_t loc,uint32_t seq,uint32_t oseq){ OCG_QueryInfo q{flags,(uint8_t)con,loc,seq,oseq}; return OCG_DuelQuery(d,len,&q); }
}
extern "C" {
EXP("ygo_query_loc") void* ygo_query_loc(OCG_Duel d,uint32_t* len,uint32_t flags,uint32_t con,uint32_t loc){ OCG_QueryInfo q{flags,(uint8_t)con,loc,0,0}; return OCG_DuelQueryLocation(d,len,&q); }
}
