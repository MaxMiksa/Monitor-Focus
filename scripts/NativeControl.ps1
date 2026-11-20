function Send-Go([hashtable]$Request=@{Action='snapshot'},[switch]$AllowError,[switch]$Legacy) {
    $channel=if($Legacy){'MonitorsFocus.Go.Control'}else{'MyScreen.Control'}
    $pipe=[IO.Pipes.NamedPipeClientStream]::new('.',"$channel.$env:USERNAME.native",[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $pipe.Connect(3000)
        $writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),1024,$true)
        $reader=[IO.StreamReader]::new($pipe)
        $writer.WriteLine((@{Id=[guid]::NewGuid().ToString();Request=$Request}|ConvertTo-Json -Depth 40 -Compress));$writer.Flush()
        $task=$reader.ReadLineAsync();if(-not $task.Wait(15000)){throw 'Response timeout, not hardware cancellation'}
        $reply=$task.Result|ConvertFrom-Json
        if($reply.Error -and -not $AllowError){throw $reply.Error};return $reply.Snapshot
    }finally{$pipe.Dispose()}
}
