import {buildArchitectureLayout,type LayoutInput} from './architectureLayout'
self.onmessage=(event:MessageEvent<LayoutInput>)=>{try{self.postMessage({layout:buildArchitectureLayout(event.data)})}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)})}}
