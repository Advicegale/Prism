import {Component,createRef,type ReactNode} from 'react'

interface Props {readingKey:string;revision:unknown;children:ReactNode}
interface Anchor {element:HTMLElement;top:number}

/** Capture before React changes the DOM, including updates above this workspace. */
export class ReadingPosition extends Component<Props,object,Anchor|null>{
 private root=createRef<HTMLDivElement>()
 getSnapshotBeforeUpdate(previous:Props):Anchor|null{
  if(previous.readingKey!==this.props.readingKey||previous.revision===this.props.revision)return null
  const lines=this.root.current?.querySelectorAll<HTMLElement>('.review-file-diff .diff-line')||[]
  for(const element of lines){const rect=element.getBoundingClientRect();if(rect.bottom>80&&rect.top<window.innerHeight)return {element,top:rect.top}}
  return null
 }
 componentDidUpdate(_previous:Props,_state:object,anchor:Anchor|null){
  if(!anchor?.element.isConnected)return
  const delta=anchor.element.getBoundingClientRect().top-anchor.top
  if(Math.abs(delta)>0.5)window.scrollBy({top:delta,behavior:'instant'})
 }
 render(){return <div ref={this.root} style={{display:'contents'}}>{this.props.children}</div>}
}
